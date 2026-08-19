/**
 * gh.ts — thin wrappers around the `gh` CLI and `git`. The one canonical
 * copy shared by every script and MCP server in this repo (workflow-invoked
 * `src/scripts/**` and Atoma-tool-invoked `src/atoma/tools/scripts/**`
 * alike) -- see build-dist.ts for how this stays true in the deployed
 * output despite living in one shared place at dev time.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string[]): RunResult {
  const proc = Bun.spawnSync({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "",
    stderr: proc.stderr ? proc.stderr.toString("utf8").trim() : "",
  };
}

/** Run the `gh` CLI. Inherits GH_TOKEN from the parent environment. */
export function gh(...args: string[]): RunResult {
  return run(["gh", ...args]);
}

/**
 * Run a READ through `gh`, treating an upstream failure as no answer rather than as
 * an answer of "no".
 *
 * GitHub returned `HTTP 504` for one `gh api repos/.../pulls/427` call and the run
 * died on it: the reviewer never started, and the pull request carried a red check
 * for a defect in neither the code nor the machinery. There is nothing to learn from
 * a 504 and nothing for an agent to do about it.
 *
 * Reads only, which is the whole reason this is a separate function rather than a
 * change to `gh` itself. A mutation that returns 502 may well have been applied, and
 * the invariants here are the kind a second attempt breaks -- one comment per run,
 * one dispatch per handoff. So the retry has to be asked for, by a caller that knows
 * its call changes nothing.
 *
 * Three attempts, widening, because the point is to outlast a blip rather than to
 * sit out an outage: a run holds a runner while it sleeps.
 */
export function ghRead(...args: string[]): RunResult {
  let result = gh(...args);
  for (const delay of [2_000, 6_000]) {
    if (result.code === 0 || !looksTransient(result)) return result;
    console.error(
      `::warning::gh ${args.slice(0, 2).join(" ")} failed transiently, retrying: ${result.stderr || result.stdout}`,
    );
    Bun.sleepSync(delay);
    result = gh(...args);
  }
  return result;
}

/**
 * Whether a failure came from the far end rather than from the request.
 *
 * A 404 is an answer; a 504 is the absence of one. 429 belongs here as well: it is a
 * request to wait, and waiting is what a retry does.
 */
export function looksTransient(result: RunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`;
  // Character classes rather than shorthand: this line has lost a backslash to
  // tooling twice, and `5dd` compiles just as happily as the version that works.
  if (/HTTP (429|5[0-9][0-9])(?![0-9])/.test(text)) return true;
  return /(timeout|timed out|connection reset|unexpected EOF|TLS handshake|temporary failure)/i.test(text);
}

/**
 * Run `gh` and keep its stdout as bytes.
 *
 * `gh` above decodes stdout as UTF-8 and trims it, which is right for JSON and
 * ruinous for anything else: a PNG through that comes out as replacement
 * characters with its ends shaved off. Anything binary — an attached image, a
 * downloaded asset — has to come through here instead.
 */
export function ghBytes(...args: string[]): { code: number; bytes: Uint8Array } {
  const proc = Bun.spawnSync({ cmd: ["gh", ...args], stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, bytes: proc.stdout ?? new Uint8Array() };
}

/**
 * Run `gh` and parse its stdout as JSON. Throws on non-zero exit.
 *
 * `T | null`, because empty stdout produces `null` and the signature used to say
 * `T`. `null as T` is a cast that makes the type system agree with a claim that
 * is not true: the one production caller defends with `?? []`, and the next one
 * would have had no reason to.
 */
export function ghJson<T = unknown>(...args: string[]): T | null {
  const { code, stdout, stderr } = gh(...args);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")}: ${stderr || stdout}`);
  }
  return stdout ? (JSON.parse(stdout) as T) : null;
}

/** Run a GraphQL query via `gh api graphql`. */
export function ghGraphql<T = unknown>(
  query: string,
  variables: Record<string, string | number> = {},
): T {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push("-F", `${key}=${value}`);
  }
  const { code, stdout, stderr } = gh(...args);
  if (code !== 0) {
    throw new Error(`GraphQL query failed: ${stderr || stdout.slice(0, 200)}`);
  }
  const result = JSON.parse(stdout) as { data?: T; errors?: unknown };
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }
  return result.data as T;
}

/** Run a `git` command. */
export function gitRun(...args: string[]): RunResult {
  return run(["git", ...args]);
}

/**
 * Splits a string of one or more back-to-back, complete top-level JSON
 * values (objects or arrays, no separator between them) into an array of
 * parsed values -- what `gh api ... --paginate` (without `--jq`) actually
 * emits on stdout: each page's whole response body written in sequence, not
 * a single valid JSON document.
 */
function splitConcatenatedJson(text: string): unknown[] {
  const results: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return results;
}

/**
 * Run `gh api <path> --paginate` and flatten the concatenated per-page JSON
 * arrays into a single array -- the TS equivalent of the common
 * `gh api ... --paginate | jq -s 'add // []'` bash idiom. Throws on
 * non-zero exit.
 */
export function ghPaginated<T = unknown>(...args: string[]): T[] {
  const { code, stdout, stderr } = gh(...args, "--paginate");
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} --paginate: ${stderr || stdout}`);
  }
  if (!stdout.trim()) return [];
  const flat: T[] = [];
  for (const page of splitConcatenatedJson(stdout)) {
    if (Array.isArray(page)) flat.push(...(page as T[]));
  }
  return flat;
}

/**
 * Fire a `workflow_dispatch`, with the one error shape every caller wants.
 *
 * Four call sites had grown their own copy of this: run `gh workflow run`, log a
 * WARN with the combined stderr/stdout on failure, log the success otherwise,
 * return whether it took. The duplication mattered because a dispatch failing
 * quietly is how an agent chain stops without anyone noticing, so the reporting
 * is the substance here, not boilerplate.
 *
 * `context` prefixes both messages so a log line still says who was dispatching.
 */
export function dispatchWorkflow(
  context: string,
  workflow: string,
  args: string[] = [],
  log: (message: string) => void = (m) => console.error(m),
): boolean {
  const { code, stdout, stderr } = gh("workflow", "run", workflow, ...args);
  if (code) {
    log(`${context}: WARN failed to dispatch ${workflow}: ${stderr || stdout}`);
    return false;
  }
  log(`${context}: dispatched ${workflow}`);
  return true;
}

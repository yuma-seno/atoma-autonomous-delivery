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

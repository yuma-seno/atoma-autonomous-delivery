/**
 * gh.ts — thin wrappers around the `gh` CLI and `git`, used by every script
 * in this directory. Self-contained: do not import anything outside
 * `.github/`.
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

/** Run `gh` and parse its stdout as JSON. Throws on non-zero exit. */
export function ghJson<T = unknown>(...args: string[]): T {
  const { code, stdout, stderr } = gh(...args);
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")}: ${stderr || stdout}`);
  }
  return stdout ? (JSON.parse(stdout) as T) : (null as T);
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

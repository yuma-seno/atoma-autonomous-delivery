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

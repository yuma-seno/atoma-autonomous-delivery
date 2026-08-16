/**
 * harness.ts — shared test helpers for spawning src/scripts/*.ts with a fake
 * `gh` CLI (testing/bin/gh) and/or an isolated config.json, so a script that
 * shells out to `gh` or reads `.github/atoma/config.json` can be tested without
 * touching the real GitHub API or this repository's own shared config.
 *
 * Everything here is used from more than one test file. When the scripts' tests
 * lived in a single file these helpers sat at the top of it; splitting that file
 * per script is what moved them here, and what they need to stay is: no test
 * file should define its own way of running a script.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_GH_BIN_DIR = join(HERE, "bin");

export interface FakeGhRule {
  /** Every one of these substrings must appear in at least one argv element for this rule to match. */
  match: string[];
  stdout?: string;
  code?: number;
}

export interface RunWithFakeGhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every `gh` invocation made during the run, in order, as argv arrays. */
  ghCalls: string[][];
}

/**
 * Runs `bun run <scriptAbsPath> ...args` with a fake `gh` on PATH configured
 * by `rules`. Returns the process result plus every `gh` invocation actually
 * made, so tests can assert on exact commands issued, not just the script's
 * own stdout.
 */
export function runWithFakeGh(
  scriptAbsPath: string,
  args: string[] = [],
  opts: { rules?: FakeGhRule[]; env?: Record<string, string>; cwd?: string } = {},
): RunWithFakeGhResult {
  const dir = mkdtempSync(join(tmpdir(), "atoma-fakegh-"));
  const logPath = join(dir, "gh-calls.jsonl");
  writeFileSync(logPath, "");
  try {
    const r = spawnSync("bun", ["run", scriptAbsPath, ...args], {
      encoding: "utf8",
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
        PATH: `${FAKE_GH_BIN_DIR}:${process.env.PATH}`,
        FAKE_GH_RESPONSES: JSON.stringify(opts.rules ?? []),
        FAKE_GH_LOG: logPath,
      },
    });
    const ghCalls = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, ghCalls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Creates a fresh temp directory containing `.github/atoma/config.json`
 * with the given content, for scripts that read config via `lib/config.ts`
 * (which always resolves that path relative to `cwd`). Caller is
 * responsible for `rmSync(dir, { recursive: true, force: true })`.
 */
export function makeConfigDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "atoma-config-"));
  mkdirSync(join(dir, ".github/atoma"), { recursive: true });
  writeFileSync(join(dir, ".github/atoma/config.json"), JSON.stringify(config));
  return dir;
}

/** Where the scripts under test live, relative to the repository root. */
export const SCRIPTS_DIR = "src/scripts";

/**
 * The absolute path of a script under test.
 *
 * `runWithFakeGh` wants an absolute path, and every caller was building the
 * same one by hand. Naming it once means a test says which script it is about
 * and nothing else.
 */
export function scriptPath(name: string): string {
  return join(process.cwd(), SCRIPTS_DIR, name);
}

/**
 * Run a script the way the workflows run it: from the deployed tree.
 *
 * Scripts that read config through a cwd-relative path expect cwd to be the
 * repository root of a deployed adoption, which for this repository before
 * anything is copied anywhere is `dist/`. The script path stays absolute so the
 * relative `bun run <script>` argument still resolves from there.
 */
export function runScript(name: string, env: Record<string, string> = {}) {
  return spawnSync("bun", ["run", join(process.cwd(), SCRIPTS_DIR, name)], {
    encoding: "utf8",
    cwd: join(process.cwd(), "dist"),
    env: { ...process.env, ...env },
  });
}

/** Parse a `$GITHUB_OUTPUT` file's `key=value` lines into an object. */
export function parseGithubOutput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

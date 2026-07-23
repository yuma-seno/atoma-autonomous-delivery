/**
 * harness.ts — shared test helper for spawning src/scripts/*.ts with a fake
 * `gh` CLI (testing/bin/gh) and/or an isolated config.json, so scripts.test.ts
 * can test the many scripts that shell out to `gh` and/or read
 * `.github/atoma/config.json` without touching the real GitHub API or the
 * repo's own shared config.
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

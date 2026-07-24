/**
 * fake-gh.ts — shared helper for tests/e2e/*.e2e.test.ts: configures the
 * fake `gh` CLI (reuses src/scripts/testing/bin/gh -- same configurable
 * design already needed there, no reason to keep a second byte-identical
 * copy) via env vars and returns those env vars plus a way to read back
 * every invocation made. Meant to be spread into the *top-level* `atoma`
 * binary's own spawn env (not per-MCP-server env in tools.yaml) -- every
 * spawned MCP server, and every script THEY in turn spawn, inherits it
 * down the process tree automatically.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_GH_BIN_DIR = join(HERE, "..", "..", "src", "scripts", "testing", "bin");

export interface FakeGhRule {
  /** Every one of these substrings must appear in at least one argv element for this rule to match. */
  match: string[];
  stdout?: string;
  code?: number;
}

export interface FakeGh {
  env: Record<string, string>;
  /** Every `gh` invocation made so far, anywhere in the process tree, in order. */
  calls(): string[][];
}

export function setupFakeGh(rules: FakeGhRule[]): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), "atoma-e2e-fakegh-"));
  const logPath = join(dir, "gh-calls.jsonl");
  writeFileSync(logPath, "");
  return {
    env: {
      PATH: `${FAKE_GH_BIN_DIR}:${process.env.PATH}`,
      FAKE_GH_RESPONSES: JSON.stringify(rules),
      FAKE_GH_LOG: logPath,
    },
    calls: () =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}

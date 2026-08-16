import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptPath } from "./testing/harness.ts";

describe("inject_uncommitted_notice.ts", () => {
  test("appends a commit-and-push notice to the given session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const sessionFile = join(dir, "session.json");
      writeFileSync(sessionFile, JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
      const r = spawnSync("bun", ["run", scriptPath("inject_uncommitted_notice.ts"), sessionFile], {
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      const session = JSON.parse(readFileSync(sessionFile, "utf8")) as { messages: { role: string; content: string }[] };
      expect(session.messages.at(-1)?.content).toContain("github__commit_and_push");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-ops quietly when no session.json can be found", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const r = spawnSync("bun", ["run", scriptPath("inject_uncommitted_notice.ts")], { encoding: "utf8", cwd: dir });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("nothing to do");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptPath } from "./testing/harness.ts";

const run = (args: string[], cwd?: string) =>
  spawnSync("bun", ["run", scriptPath("inject_uncommitted_notice.ts"), ...args], { encoding: "utf8", cwd });

describe("inject_uncommitted_notice.ts", () => {
  test("appends a commit-and-push notice to the given session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const sessionFile = join(dir, "session.json");
      writeFileSync(sessionFile, JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
      const r = run(["--session", sessionFile]);
      expect(r.status).toBe(0);
      const session = JSON.parse(readFileSync(sessionFile, "utf8")) as { messages: { role: string; content: string }[] };
      expect(session.messages.at(-1)?.content).toContain("github__commit_and_push");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A session that was never written is a normal outcome: the step calling this
   * also runs after a short or failed run. So the file being absent is reported and
   * tolerated, while being asked for nothing at all is a mistake in the caller.
   */
  test("a missing session file is reported and tolerated", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const r = run(["--session", join(dir, "session.json")]);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("nothing to do");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * No argument used to mean "search the work tree for the first file called
   * `session.json`, three levels deep". That was harmless while the session lived
   * in the repository root and became a hazard when it moved out: the search would
   * find an adopter's own `session.json` -- a test fixture, say -- and append this
   * notice to THEIR file, which the same `git add -A` it asks for would then commit.
   *
   * So it is an error rather than a fallback. Searching for a file by name in
   * someone else's tree is a guess, and this one wrote to what it guessed.
   */
  test("refuses to guess when given no session path", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      // A file the old search would have found and written to.
      const decoy = join(dir, "session.json");
      writeFileSync(decoy, JSON.stringify({ messages: [] }));
      const r = run([], dir);
      expect(r.status, "exits non-zero rather than picking a file").not.toBe(0);
      expect(r.stderr).toContain("--session");
      expect(readFileSync(decoy, "utf8"), "and leaves it alone").toBe(JSON.stringify({ messages: [] }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

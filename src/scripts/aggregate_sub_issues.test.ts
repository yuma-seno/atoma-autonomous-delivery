import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeConfigDir, runWithFakeGh, scriptPath } from "./testing/harness.ts";

describe("aggregate_sub_issues.ts", () => {
  test("posts a progress comment and returns early when siblings remain open", () => {
    // Needs BOTH a real git repo (the gitRun("config", ...) calls at the top
    // of main() need one) AND a .github/atoma/config.json (the nested
    // check_open_siblings.ts call inherits this same cwd and reads config.json
    // via getLabel()) in the SAME directory.
    const dir = makeConfigDir({});
    spawnSync("git", ["init"], { cwd: dir });
    try {
      const r = runWithFakeGh(
        scriptPath("aggregate_sub_issues.ts"),
        ["--repo", "owner/repo", "--parent", "5", "--closed-num", "9"],
        { cwd: dir, rules: [{ match: ["issue", "list"], stdout: JSON.stringify([{ number: 1 }]) }] },
      );
      expect(r.status).toBe(0);
      // stderr, not stdout: every diagnostic in this script goes to stderr so
      // that stdout stays free for data a caller may consume.
      // The property, not the wording. This used to pin the exact sentence "Not all
      // sub-tasks done yet", which said nothing about how many remained -- the gate
      // now reports the count, and a test that pins prose blocks that kind of
      // improvement while catching none of the defects that matter.
      expect(r.stderr).toContain("1 sibling(s)");
      expect(r.stderr).toContain("No action needed");
      const commentCall = r.ghCalls.find((c) => c.includes("comment"));
      expect(commentCall?.join(" ")).toContain("atoma:sub-result=9");
      // The full aggregation path (siblingCount === 0) additionally performs
      // real `git` operations against an `atoma-data` branch/remote
      // (checkout --orphan, commit, push-with-retry-on-race) -- deliberately
      // not covered here; it would need a full git remote fixture for
      // comparatively low additional confidence over this early-return path.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

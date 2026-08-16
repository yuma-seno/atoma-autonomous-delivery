import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeConfigDir, runWithFakeGh, scriptPath } from "./testing/harness.ts";

describe("guard_comment_during_run.ts", () => {
  test("deletes the comment and notifies the commenter when in_progress is set", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        scriptPath("guard_comment_during_run.ts"),
        ["--number", "9", "--comment-id", "123", "--commenter", "octocat"],
        {
          cwd: configDir,
          env: { GITHUB_REPOSITORY: "owner/repo" },
          rules: [
            { match: ["issue", "view", "labels"], stdout: "true" },
            { match: ["api", "DELETE"] },
            { match: ["issue", "comment"] },
          ],
        },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("DELETE") && c.join(" ").includes("comments/123"))).toBe(true);
      const commentCall = r.ghCalls.find((c) => c.includes("comment"));
      expect(commentCall?.join(" ")).toContain("@octocat");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("leaves the comment alone when the issue is not in_progress", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        scriptPath("guard_comment_during_run.ts"),
        ["--number", "9", "--comment-id", "123", "--commenter", "octocat"],
        {
          cwd: configDir,
          env: { GITHUB_REPOSITORY: "owner/repo" },
          rules: [{ match: ["issue", "view", "labels"], stdout: "false" }],
        },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("DELETE"))).toBe(false);
      expect(r.ghCalls.some((c) => c.includes("comment"))).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

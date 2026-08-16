import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeConfigDir, runWithFakeGh, scriptPath } from "./testing/harness.ts";

describe("dispatch_if_siblings_done.ts", () => {
  test("dispatches the orchestrator once all siblings are done", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        scriptPath("dispatch_if_siblings_done.ts"),
        ["--repo", "owner/repo", "--parent", "5", "--closed-num", "9"],
        {
          cwd: configDir,
          rules: [
            { match: ["issue", "list"], stdout: "[]" },
            { match: ["issue", "view", "comments"], stdout: "" },
            { match: ["issue", "comment"] },
            { match: ["workflow", "run"] },
          ],
        },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("comment"))).toBe(true);
      expect(r.ghCalls.some((c) => c[0] === "workflow" && c[1] === "run")).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("skips dispatch when the aggregation marker is already present", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        scriptPath("dispatch_if_siblings_done.ts"),
        ["--repo", "owner/repo", "--parent", "5", "--closed-num", "9"],
        {
          cwd: configDir,
          rules: [
            { match: ["issue", "list"], stdout: "[]" },
            { match: ["issue", "view", "comments"], stdout: "<!-- atoma:aggregated=9 -->\nAtoma: All sub-tasks completed." },
          ],
        },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("comment"))).toBe(false);
      expect(r.ghCalls.some((c) => c[0] === "workflow")).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("does nothing when siblings are still open", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        scriptPath("dispatch_if_siblings_done.ts"),
        ["--repo", "owner/repo", "--parent", "5", "--closed-num", "9"],
        { cwd: configDir, rules: [{ match: ["issue", "list"], stdout: JSON.stringify([{ number: 1 }]) }] },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("comment"))).toBe(false);
      expect(r.ghCalls.some((c) => c[0] === "workflow")).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

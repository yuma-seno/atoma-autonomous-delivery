import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeConfigDir, runWithFakeGh, scriptPath } from "./testing/harness.ts";

describe("manage_in_progress_label.ts", () => {
  test("adds the in_progress label", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(scriptPath("manage_in_progress_label.ts"), ["--action", "add", "--number", "42"], {
        cwd: configDir,
        rules: [{ match: ["label"] }, { match: ["issue", "edit"] }],
      });
      expect(r.status).toBe(0);
      const editCall = r.ghCalls.find((c) => c.includes("edit"));
      expect(editCall).toContain("--add-label");
      expect(editCall).toContain("atoma/in-progress");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("removes the in_progress label", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(scriptPath("manage_in_progress_label.ts"), ["--action", "remove", "--number", "42"], {
        cwd: configDir,
        rules: [{ match: ["issue", "edit"] }],
      });
      expect(r.status).toBe(0);
      const editCall = r.ghCalls.find((c) => c.includes("edit"));
      expect(editCall).toContain("--remove-label");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

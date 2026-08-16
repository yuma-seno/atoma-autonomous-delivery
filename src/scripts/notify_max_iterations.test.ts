import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runWithFakeGh, scriptPath } from "./testing/harness.ts";

describe("notify_max_iterations.ts", () => {
  test("mentions the notify login when given", () => {
    const r = runWithFakeGh(
      scriptPath("notify_max_iterations.ts"),
      ["--number", "7", "--agent", "engineer", "--notify", "octocat"],
      { rules: [{ match: ["issue", "comment"] }] },
    );
    expect(r.status).toBe(0);
    const commentCall = r.ghCalls.find((c) => c.includes("comment"));
    expect(commentCall?.join(" ")).toContain("@octocat");
    expect(commentCall?.join(" ")).toContain("engineer");
  });

  test("omits the mention when notify is not given", () => {
    const r = runWithFakeGh(scriptPath("notify_max_iterations.ts"), ["--number", "7", "--agent", "engineer"], {
      rules: [{ match: ["issue", "comment"] }],
    });
    expect(r.status).toBe(0);
    const commentCall = r.ghCalls.find((c) => c.includes("comment"));
    expect(commentCall?.join(" ")).not.toContain("@");
  });
});

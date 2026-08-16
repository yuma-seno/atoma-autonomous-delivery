import { describe, expect, test } from "bun:test";
import { runScript } from "./testing/harness.ts";

describe("match_trigger.ts", () => {
  test("PR opened -> reviewer", () => {
    const r = runScript("match_trigger.ts", { EVENT_TYPE: "pull_request.opened" });
    expect(r.stdout.trim()).toBe("reviewer");
  });

  test("changes_requested -> engineer", () => {
    const r = runScript("match_trigger.ts", {
      EVENT_TYPE: "pull_request_review.submitted",
      REVIEW_STATE: "changes_requested",
    });
    expect(r.stdout.trim()).toBe("engineer");
  });

  test("approved -> no match", () => {
    const r = runScript("match_trigger.ts", {
      EVENT_TYPE: "pull_request_review.submitted",
      REVIEW_STATE: "approved",
    });
    expect(r.stdout.trim()).toBe("");
  });
});

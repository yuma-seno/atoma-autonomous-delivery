import { describe, expect, test } from "bun:test";
import { decideValidationOutcome } from "./pr-validation.ts";

const contexts = ["check"];

describe("decideValidationOutcome", () => {
  test("a successful run writes passing checks and hands to the reviewer", () => {
    const outcome = decideValidationOutcome("success", contexts, "reviewer", "engineer");
    expect(outcome.checks).toEqual([{ name: "check", conclusion: "success" }]);
    expect(outcome.nextAgent).toBe("reviewer");
  });

  // GitHub's own list of conclusions that satisfy a required check, so a job the
  // repository chose to skip must not read as a defect to fix.
  test("skipped and neutral pass like success", () => {
    for (const conclusion of ["skipped", "neutral"]) {
      const outcome = decideValidationOutcome(conclusion, contexts, "reviewer", "engineer");
      expect(outcome.nextAgent, conclusion).toBe("reviewer");
      expect(outcome.checks[0]?.conclusion, conclusion).toBe("success");
    }
  });

  test("a failing run writes failing checks and returns to the engineer", () => {
    const outcome = decideValidationOutcome("failure", contexts, "reviewer", "engineer");
    expect(outcome.checks).toEqual([{ name: "check", conclusion: "failure" }]);
    expect(outcome.nextAgent).toBe("engineer");
    expect(outcome.summary).toContain("failure");
  });

  test("cancelled and timed_out return to the engineer too", () => {
    for (const conclusion of ["cancelled", "timed_out"]) {
      expect(decideValidationOutcome(conclusion, contexts, "reviewer", "engineer").nextAgent, conclusion).toBe(
        "engineer",
      );
    }
  });

  // No conclusion means the run never reported -- it timed out here, or could not
  // be found. There is no defect for an engineer to fix, and dispatching one
  // spends a model run to discover that. Block the merge and stop.
  test("no conclusion writes a failing check but dispatches nobody", () => {
    const outcome = decideValidationOutcome("", contexts, "reviewer", "engineer");
    expect(outcome.checks).toEqual([{ name: "check", conclusion: "failure" }]);
    expect(outcome.nextAgent).toBe("");
    expect(outcome.summary).toContain("human");
  });

  test("every required context gets its own check", () => {
    const outcome = decideValidationOutcome("success", ["check", "lint", "build"], "reviewer", "engineer");
    expect(outcome.checks.map((c) => c.name)).toEqual(["check", "lint", "build"]);
  });

  // A ruleset with no required checks still has to route the agents; it just has
  // nothing to write.
  test("no required contexts still routes", () => {
    const outcome = decideValidationOutcome("success", [], "reviewer", "engineer");
    expect(outcome.checks).toEqual([]);
    expect(outcome.nextAgent).toBe("reviewer");
  });

  test("conclusions are matched case- and space-insensitively", () => {
    expect(decideValidationOutcome("  SUCCESS ", contexts, "reviewer", "engineer").nextAgent).toBe("reviewer");
  });
});

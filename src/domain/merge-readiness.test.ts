import { describe, expect, test } from "bun:test";
import { decideMergeReadiness, formatBlockers, type MergeSignals } from "./merge-readiness.ts";

function signals(overrides: Partial<MergeSignals> = {}): MergeSignals {
  return {
    mergeStateStatus: "CLEAN",
    state: "OPEN",
    checks: [{ name: "check", status: "completed", conclusion: "success" }],
    requiredChecks: ["check"],
    mergePolicy: "auto",
    ...overrides,
  };
}

const kinds = (s: MergeSignals) => decideMergeReadiness(s).blockers.map((b) => b.kind);

describe("decideMergeReadiness", () => {
  test("CLEAN with an auto policy is ready", () => {
    const result = decideMergeReadiness(signals());
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.needsCiDispatch).toBe(false);
  });

  // The point of reading mergeStateStatus rather than deciding locally: the
  // ruleset determines which checks matter, so a failing check that the ruleset
  // does not require must not block. GitHub reports exactly that as UNSTABLE.
  test("UNSTABLE is ready — a non-required check failing is the ruleset's call", () => {
    const result = decideMergeReadiness(
      signals({
        mergeStateStatus: "UNSTABLE",
        checks: [
          { name: "check", status: "completed", conclusion: "success" },
          { name: "optional-lint", status: "completed", conclusion: "failure" },
        ],
      }),
    );
    expect(result.ready).toBe(true);
  });

  test("BLOCKED names the required check that is failing", () => {
    const result = decideMergeReadiness(
      signals({
        mergeStateStatus: "BLOCKED",
        checks: [
          { name: "check", status: "completed", conclusion: "failure", detailsUrl: "https://example/run/1" },
        ],
      }),
    );
    expect(result.blockers.map((b) => b.kind)).toEqual(["checks-failing"]);
    expect(result.blockers[0]?.detail).toContain('"check"');
    expect(result.blockers[0]?.detail).toContain("https://example/run/1");
    expect(result.needsCiDispatch).toBe(false);
  });

  test("BLOCKED with a required check that never ran asks for a dispatch", () => {
    const result = decideMergeReadiness(signals({ mergeStateStatus: "BLOCKED", checks: [] }));
    expect(result.blockers.map((b) => b.kind)).toEqual(["checks-missing"]);
    expect(result.needsCiDispatch).toBe(true);
  });

  test("BLOCKED with a required check still running reports pending, not a dispatch", () => {
    const result = decideMergeReadiness(
      signals({
        mergeStateStatus: "BLOCKED",
        checks: [{ name: "check", status: "in_progress", conclusion: null }],
      }),
    );
    expect(result.blockers.map((b) => b.kind)).toEqual(["checks-pending"]);
    expect(result.needsCiDispatch).toBe(false);
  });

  test("BLOCKED for a reason outside the checks says so instead of guessing", () => {
    // e.g. the ruleset requires an approving review, which no check run explains.
    const result = decideMergeReadiness(signals({ mergeStateStatus: "BLOCKED" }));
    expect(result.blockers.map((b) => b.kind)).toEqual(["blocked"]);
    expect(result.blockers[0]?.detail).toContain("outside the required checks");
  });

  test("a required check absent from the ruleset is not invented", () => {
    // No required checks declared: a failing run cannot be the blocker, so the
    // raw verdict is reported rather than a check name.
    const result = decideMergeReadiness(
      signals({
        mergeStateStatus: "BLOCKED",
        requiredChecks: [],
        checks: [{ name: "check", status: "completed", conclusion: "failure" }],
      }),
    );
    expect(result.blockers.map((b) => b.kind)).toEqual(["blocked"]);
  });

  test("DIRTY, BEHIND, DRAFT and a closed PR each block distinctly", () => {
    expect(kinds(signals({ mergeStateStatus: "DIRTY" }))).toEqual(["conflicting"]);
    expect(kinds(signals({ mergeStateStatus: "BEHIND" }))).toEqual(["behind"]);
    expect(kinds(signals({ mergeStateStatus: "DRAFT" }))).toEqual(["draft"]);
    expect(kinds(signals({ state: "CLOSED" }))).toContain("not-open");
  });

  test("an uncomputed merge state blocks as unknown", () => {
    expect(kinds(signals({ mergeStateStatus: "UNKNOWN" }))).toEqual(["mergeability-unknown"]);
  });

  test("cancelled and timed_out count as a failing required check", () => {
    for (const conclusion of ["cancelled", "timed_out", "action_required", "stale"]) {
      const result = decideMergeReadiness(
        signals({
          mergeStateStatus: "BLOCKED",
          checks: [{ name: "check", status: "completed", conclusion }],
        }),
      );
      expect(result.blockers[0]?.kind, `${conclusion} should fail`).toBe("checks-failing");
    }
  });

  test("skipped and neutral satisfy a required check", () => {
    for (const conclusion of ["skipped", "neutral", "success"]) {
      const result = decideMergeReadiness(
        signals({
          mergeStateStatus: "BLOCKED",
          checks: [{ name: "check", status: "completed", conclusion }],
        }),
      );
      // Nothing in the required checks explains the block, so it falls through.
      expect(result.blockers.map((b) => b.kind), conclusion).toEqual(["blocked"]);
    }
  });

  test("a non-auto merge policy blocks even when GitHub is happy", () => {
    const result = decideMergeReadiness(signals({ mergePolicy: "manual" }));
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.kind)).toEqual(["merge-policy"]);
    expect(result.needsCiDispatch).toBe(false);
  });

  test("a dispatch is not requested when something else is also wrong", () => {
    const result = decideMergeReadiness(
      signals({ mergeStateStatus: "BLOCKED", checks: [], mergePolicy: "manual" }),
    );
    expect(result.needsCiDispatch).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(1);
  });

  test("blockers render as a numbered, kind-tagged list", () => {
    const { blockers } = decideMergeReadiness(
      signals({ mergeStateStatus: "DIRTY", mergePolicy: "manual" }),
    );
    const text = formatBlockers(blockers);
    expect(text).toContain("1. [conflicting]");
    expect(text).toContain("2. [merge-policy]");
  });
});

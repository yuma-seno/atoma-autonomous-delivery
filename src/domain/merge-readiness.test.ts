import { describe, expect, test } from "bun:test";
import { decideMergeReadiness, formatBlockers, type MergeSignals } from "./merge-readiness.ts";

function signals(overrides: Partial<MergeSignals> = {}): MergeSignals {
  return {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    isDraft: false,
    state: "OPEN",
    checks: [{ name: "check", status: "completed", conclusion: "success" }],
    mergePolicy: "auto",
    ...overrides,
  };
}

const kinds = (s: MergeSignals) => decideMergeReadiness(s).blockers.map((b) => b.kind);

describe("decideMergeReadiness", () => {
  test("a clean, checked, mergeable PR is ready", () => {
    const result = decideMergeReadiness(signals());
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.needsCiDispatch).toBe(false);
  });

  test("an absent check run blocks and asks for a CI dispatch", () => {
    const result = decideMergeReadiness(signals({ checks: [] }));
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.kind)).toEqual(["no-checks"]);
    expect(result.needsCiDispatch).toBe(true);
  });

  test("a failing check blocks and names the check", () => {
    const result = decideMergeReadiness(
      signals({
        checks: [
          { name: "check", status: "completed", conclusion: "failure", detailsUrl: "https://example/run/1" },
        ],
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers[0]?.kind).toBe("checks-failing");
    expect(result.blockers[0]?.detail).toContain('"check"');
    expect(result.blockers[0]?.detail).toContain("https://example/run/1");
  });

  test("cancelled and timed_out count as failing", () => {
    for (const conclusion of ["cancelled", "timed_out", "action_required", "stale"]) {
      const result = decideMergeReadiness(
        signals({ checks: [{ name: "check", status: "completed", conclusion }] }),
      );
      expect(result.ready, `${conclusion} should block`).toBe(false);
      expect(result.blockers[0]?.kind).toBe("checks-failing");
    }
  });

  test("skipped and neutral do not block", () => {
    for (const conclusion of ["skipped", "neutral", "success"]) {
      const result = decideMergeReadiness(
        signals({ checks: [{ name: "check", status: "completed", conclusion }] }),
      );
      expect(result.ready, `${conclusion} should pass`).toBe(true);
    }
  });

  test("an in-flight check blocks as pending, not as a dispatch request", () => {
    const pending = signals({ checks: [{ name: "check", status: "in_progress", conclusion: null }] });
    const result = decideMergeReadiness(pending);

    expect(result.ready).toBe(false);
    expect(kinds(pending)).toEqual(["checks-pending"]);
    expect(result.blockers[0]?.detail).toContain("check");
    expect(result.needsCiDispatch).toBe(false);
  });

  test("a failing check outranks a pending one", () => {
    const result = decideMergeReadiness(
      signals({
        checks: [
          { name: "slow", status: "in_progress", conclusion: null },
          { name: "fast", status: "completed", conclusion: "failure" },
        ],
      }),
    );
    expect(result.blockers.map((b) => b.kind)).toEqual(["checks-failing"]);
  });

  test("conflicts, drafts and closed PRs each block", () => {
    expect(kinds(signals({ mergeable: "CONFLICTING" }))).toContain("conflicting");
    expect(kinds(signals({ isDraft: true }))).toContain("draft");
    expect(kinds(signals({ state: "CLOSED" }))).toContain("not-open");
    expect(kinds(signals({ mergeable: "UNKNOWN" }))).toContain("mergeability-unknown");
  });

  test("a non-auto merge policy blocks even when everything else is clean", () => {
    const result = decideMergeReadiness(signals({ mergePolicy: "manual" }));
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.kind)).toEqual(["merge-policy"]);
  });

  test("a CI dispatch is not requested when something else is also wrong", () => {
    const result = decideMergeReadiness(signals({ checks: [], mergeable: "CONFLICTING" }));
    expect(result.needsCiDispatch).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(1);
  });

  test("blockers render as a numbered, kind-tagged list", () => {
    const { blockers } = decideMergeReadiness(signals({ checks: [], isDraft: true }));
    const text = formatBlockers(blockers);
    expect(text).toContain("1. [draft]");
    expect(text).toContain("[no-checks]");
  });
});

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GOVERNED_PATHS,
  decideMergeReadiness,
  formatBlockers,
  governedPathsIn,
  type MergeSignals,
} from "./merge-readiness.ts";

function signals(overrides: Partial<MergeSignals> = {}): MergeSignals {
  return {
    mergeStateStatus: "CLEAN",
    isDraft: false,
    // The agent path is what most of these cases are about, so it is the default
    // here. The human case is its own test below.
    authoredByAgent: true,
    state: "OPEN",
    checks: [{ name: "check", status: "completed", conclusion: "success" }],
    requiredChecks: ["check"],
    mergePolicy: "auto",
    governancePaths: [],
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

  // The case that actually occurs. GitHub reports `CLEAN` for a draft, so the
  // verdict alone said ready and the refusal only arrived from the merge call, as
  // `Pull Request is still a draft` -- an error no blocker kind described.
  test("a draft blocks even when the verdict is CLEAN", () => {
    const result = decideMergeReadiness(signals({ isDraft: true }));
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.kind)).toEqual(["draft"]);
  });

  test("a draft is reported once when GitHub does return DRAFT", () => {
    expect(kinds(signals({ isDraft: true, mergeStateStatus: "DRAFT" }))).toEqual(["draft"]);
  });

  // `merge_policy` bounds what an agent decides on its own, and what it was meant
  // to bound is the agent's own work. Merging a person's pull request for them
  // takes the decision away, and does it before they have read the review.
  describe("a person's pull request", () => {
    test("blocks the merge even when everything else is clean", () => {
      const result = decideMergeReadiness(signals({ authoredByAgent: false }));
      expect(result.ready).toBe(false);
      expect(result.blockers.map((b) => b.kind)).toEqual(["human-authored"]);
    });

    test("says to review and report rather than naming a defect", () => {
      const [blocker] = decideMergeReadiness(signals({ authoredByAgent: false })).blockers;
      expect(blocker?.detail).toContain("leave the merge to them");
    });

    // The reviewer still has to see the real blockers, or it would report "this
    // is yours to merge" on a pull request that cannot merge yet.
    test("is reported alongside whatever else blocks", () => {
      const result = decideMergeReadiness(signals({ authoredByAgent: false, mergeStateStatus: "DIRTY" }));
      expect(result.blockers.map((b) => b.kind)).toEqual(["conflicting", "human-authored"]);
    });

    test("an agent's own pull request is unaffected", () => {
      expect(decideMergeReadiness(signals({ authoredByAgent: true })).ready).toBe(true);
    });
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

  // The one gate an agent cannot satisfy and then merge past: the change would
  // alter the gates themselves.
  test("a change to the machinery agents run on is a person's merge", () => {
    const result = decideMergeReadiness(signals({ governancePaths: [".github/workflows/ci.yml"] }));
    expect(result.ready).toBe(false);
    expect(kinds(signals({ governancePaths: [".github/workflows/ci.yml"] }))).toEqual(["governance-change"]);
    expect(result.blockers[0]?.detail).toContain(".github/workflows/ci.yml");
  });

  // Refusing the merge is the control; saying where the change belongs is what
  // stops the same pull request being opened again. The commonest reason to edit
  // a generated workflow is to change what CI does, and under Atoma that is
  // configuration.
  test("touching a generated workflow says where CI actually gets configured", () => {
    const { blockers } = decideMergeReadiness(signals({ governancePaths: [".github/workflows/atoma-check.yml"] }));
    expect(blockers[0]?.detail).toContain("checks.commands");
    expect(blockers[0]?.detail).toContain("config.json");
  });

  test("a governed change elsewhere gets no advice about CI", () => {
    const { blockers } = decideMergeReadiness(signals({ governancePaths: [".github/atoma/agent-definitions/x.md"] }));
    expect(blockers[0]?.detail).not.toContain("checks.commands");
  });

  test("the blocker names a few paths rather than every one", () => {
    const many = Array.from({ length: 8 }, (_, i) => `.github/workflows/w${i}.yml`);
    const { blockers } = decideMergeReadiness(signals({ governancePaths: many }));
    expect(blockers[0]?.detail).toContain("+3 more");
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

describe("governedPathsIn", () => {
  test("claims everything under a named directory", () => {
    const files = [".github/workflows/ci.yml", ".github/atoma/config.json", "src/index.ts"];
    expect(governedPathsIn(files, DEFAULT_GOVERNED_PATHS)).toEqual([
      ".github/workflows/ci.yml",
      ".github/atoma/config.json",
    ]);
  });

  // The gap that retired the enumerated default. These run inside the runner
  // job, which holds contents/issues/pull-requests/actions write -- an agent
  // that could merge a change here could rewrite the rule releasing its own
  // in-progress guard, or its auto-dispatch loop limit, and the next run would
  // already obey it.
  test("covers the runner's own control scripts", () => {
    const files = [
      ".github/scripts/decide_guard_release.ts",
      ".github/scripts/manage_dispatch_loop.ts",
      ".github/scripts/save_agent_session.ts",
    ];
    expect(governedPathsIn(files, DEFAULT_GOVERNED_PATHS)).toEqual(files);
  });

  // A project that wants the old, narrower behaviour can still name parts.
  test("a project can narrow the default back to particular directories", () => {
    expect(governedPathsIn([".github/scripts/x.ts", ".github/workflows/ci.yml"], [".github/workflows/**"])).toEqual([
      ".github/workflows/ci.yml",
    ]);
  });

  test("ordinary work is not governance", () => {
    expect(governedPathsIn(["src/lib/config.ts", "docs/operations.md"], DEFAULT_GOVERNED_PATHS)).toEqual([]);
  });

  // The default names an adopter's deployed tree. A template repository develops
  // the same files under `src/`, where they are ordinary source until deployed.
  test("the default covers the deployed tree, not a template's source", () => {
    expect(governedPathsIn(["src/atoma/agent-definitions/engineer.md"], DEFAULT_GOVERNED_PATHS)).toEqual([]);
    expect(governedPathsIn(["src/atoma/agent-definitions/engineer.md"], ["src/atoma/**"])).toEqual([
      "src/atoma/agent-definitions/engineer.md",
    ]);
  });

  test("a pattern without a wildcard matches that one file", () => {
    expect(governedPathsIn(["a.yml", "a.yml.bak"], ["a.yml"])).toEqual(["a.yml"]);
  });

  test("an empty pattern list turns the gate off", () => {
    expect(governedPathsIn([".github/workflows/ci.yml"], [])).toEqual([]);
  });
});

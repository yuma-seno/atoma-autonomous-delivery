import { describe, expect, test } from "bun:test";
import { CI_RETRY_LIMIT, decideValidationOutcome } from "./pr-validation.ts";

const contexts = ["check"];

/** The two agents, named once: every case here routes between the same pair. */
const agents = { reviewerAgent: "reviewer", engineerAgent: "engineer" };

const decide = (conclusion: string, requiredContexts: string[] = contexts, priorRetries = 0) =>
  decideValidationOutcome({ conclusion, requiredContexts, ...agents, priorRetries });

describe("decideValidationOutcome", () => {
  test("a successful run writes passing checks and hands to the reviewer", () => {
    const outcome = decide("success");
    expect(outcome.verdict).toBe("passed");
    expect(outcome.checks).toEqual([{ name: "check", conclusion: "success" }]);
    expect(outcome.nextAgent).toBe("reviewer");
  });

  // GitHub's own list of conclusions that satisfy a required check, so a job the
  // repository chose to skip must not read as a defect to fix.
  test("skipped and neutral pass like success", () => {
    for (const conclusion of ["skipped", "neutral"]) {
      const outcome = decide(conclusion);
      expect(outcome.verdict, conclusion).toBe("passed");
      expect(outcome.nextAgent, conclusion).toBe("reviewer");
      expect(outcome.checks[0]?.conclusion, conclusion).toBe("success");
    }
  });

  test("a failing run writes failing checks and returns to the engineer", () => {
    const outcome = decide("failure");
    expect(outcome.verdict).toBe("failed");
    expect(outcome.checks).toEqual([{ name: "check", conclusion: "failure" }]);
    expect(outcome.nextAgent).toBe("engineer");
    expect(outcome.summary).toContain("failure");
  });

  test("cancelled and timed_out return to the engineer too", () => {
    for (const conclusion of ["cancelled", "timed_out"]) {
      expect(decide(conclusion).nextAgent, conclusion).toBe("engineer");
    }
  });

  // No conclusion means the run never reported -- it timed out here, or could not
  // be found. There is no defect for an engineer to fix, and dispatching one
  // spends a model run to discover that. Block the merge and stop.
  test("no conclusion writes a failing check but dispatches nobody", () => {
    const outcome = decide("");
    expect(outcome.verdict).toBe("no-conclusion");
    expect(outcome.checks).toEqual([{ name: "check", conclusion: "failure" }]);
    expect(outcome.nextAgent).toBe("");
    expect(outcome.summary).toContain("human");
  });

  test("every required context gets its own check", () => {
    const outcome = decide("success", ["check", "lint", "build"]);
    expect(outcome.checks.map((c) => c.name)).toEqual(["check", "lint", "build"]);
  });

  // A ruleset with no required checks still has to route the agents; it just has
  // nothing to write.
  test("no required contexts still routes", () => {
    const outcome = decide("success", []);
    expect(outcome.verdict).toBe("passed");
    expect(outcome.checks).toEqual([]);
    expect(outcome.nextAgent).toBe("reviewer");
  });

  // The reason `verdict` exists. `validate_pull_request.ts` used to ask
  // `checks.every((c) => c.conclusion === "success")`, and an empty array answers
  // `true` -- so a failing run on a base branch requiring no checks posted no
  // failure comment, dispatched the engineer with no brief, and never advanced
  // the tally that bounds the retry loop. The verdict cannot be read that way.
  test("a failing run with no required contexts is still a failure", () => {
    const outcome = decide("failure", []);
    expect(outcome.verdict).toBe("failed");
    expect(outcome.checks).toEqual([]);
    expect(outcome.checks.every((c) => c.conclusion === "success")).toBe(true);
  });

  test("conclusions are matched case- and space-insensitively", () => {
    expect(decide("  SUCCESS ").nextAgent).toBe("reviewer");
  });

  // The loop this bounds is the one `manage_dispatch_loop.ts` cannot see: the
  // engineer is dispatched by a workflow rather than by a directive it wrote, so
  // that counter never advances and failing CI would cycle indefinitely.
  describe("retry limit", () => {
    test("keeps returning to the engineer below the limit", () => {
      for (let prior = 0; prior < CI_RETRY_LIMIT; prior++) {
        expect(decide("failure", contexts, prior).nextAgent, `prior=${prior}`).toBe("engineer");
      }
    });

    test("stops dispatching at the limit and says why", () => {
      const outcome = decide("failure", contexts, CI_RETRY_LIMIT);
      expect(outcome.verdict).toBe("retries-exhausted");
      expect(outcome.nextAgent).toBe("");
      expect(outcome.summary).toContain("human");
    });

    // The check still has to be written, or the pull request would look
    // unvalidated rather than failing.
    test("still writes a failing check when it gives up", () => {
      const outcome = decide("failure", contexts, CI_RETRY_LIMIT);
      expect(outcome.checks).toEqual([{ name: "check", conclusion: "failure" }]);
    });

    test("a passing run is unaffected by earlier retries", () => {
      const outcome = decide("success", contexts, CI_RETRY_LIMIT + 5);
      expect(outcome.verdict).toBe("passed");
      expect(outcome.nextAgent).toBe("reviewer");
    });
  });
});

/**
 * A pull request whose own `.github/atoma/` cannot start a run.
 *
 * Judged before the CI conclusion, and treated as a red CI run rather than as a
 * broken job: failing checks so the merge is blocked, and the engineer dispatched
 * to fix what it wrote. The alternative — a failed workflow step — writes no check
 * at all, which leaves the required context pending forever and dispatches nobody.
 */
describe("a deliverable that cannot start a run", () => {
  const problems = ["engineer.md: mcp_servers 'shell': not found in tools file"];

  const decideWith = (deliverableProblems: string[], conclusion = "", priorRetries = 0) =>
    decideValidationOutcome({
      conclusion,
      requiredContexts: contexts,
      ...agents,
      priorRetries,
      deliverableProblems,
    });

  test("blocks the merge and returns to the engineer", () => {
    const outcome = decideWith(problems);
    expect(outcome.verdict).toBe("deliverable-invalid");
    expect(outcome.checks).toEqual([{ name: "check", conclusion: "failure" }]);
    expect(outcome.nextAgent).toBe("engineer");
  });

  // The count belongs in the summary; the problems themselves travel in the
  // comment. `summary` is also a step output, which is one line by construction.
  test("the summary names the count and stays one line", () => {
    const outcome = decideWith([...problems, "labels.launched must be a non-empty label name."]);
    expect(outcome.summary).toContain("(2 problems)");
    expect(outcome.summary).not.toContain("\n");
  });

  test("one problem is not pluralised", () => {
    expect(decideWith(problems).summary).toContain("(1 problem)");
  });

  /**
   * The ordering that matters. CI was never dispatched, so `conclusion` is empty —
   * which on its own means `no-conclusion`, a verdict that deliberately dispatches
   * NOBODY because there is no defect to hand anyone. Here there is one, and its
   * author is the agent that just wrote it.
   */
  test("an empty conclusion is not read as a run that never reported", () => {
    expect(decideWith(problems, "").verdict).toBe("deliverable-invalid");
    expect(decideWith([], "").verdict).toBe("no-conclusion");
  });

  // A green CI run cannot rescue it: what CI checked is the repository's own code,
  // and what is broken is the machinery the NEXT run loads.
  test("a passing CI conclusion does not override it", () => {
    expect(decideWith(problems, "success").verdict).toBe("deliverable-invalid");
    expect(decideWith(problems, "success").nextAgent).toBe("engineer");
  });

  // The same bound as failing CI, and for the same reason: the engineer is
  // dispatched by a workflow, so nothing else stops the loop.
  test("the retry limit applies", () => {
    for (const prior of [0, CI_RETRY_LIMIT - 1]) {
      expect(decideWith(problems, "", prior).nextAgent, `prior=${prior}`).toBe("engineer");
    }
    const outcome = decideWith(problems, "", CI_RETRY_LIMIT);
    expect(outcome.verdict).toBe("retries-exhausted");
    expect(outcome.nextAgent).toBe("");
    expect(outcome.summary).toContain("human");
    expect(outcome.checks).toEqual([{ name: "check", conclusion: "failure" }]);
  });

  test("an empty list is the normal case and changes nothing", () => {
    expect(decideWith([], "success").verdict).toBe("passed");
    expect(decideWith([], "failure").verdict).toBe("failed");
  });
});

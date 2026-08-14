/**
 * pr-validation.ts — decides what a pull request's validation run means: which
 * check contexts to write, and who works next.
 *
 * The decision half of the pair whose I/O half is `scripts/validate_pull_request.ts`.
 * Everything here is a pure function of a conclusion string and a list of
 * contexts, so the whole truth table is testable without a `gh` in the loop —
 * the same split `domain/merge-readiness.ts` uses.
 */

/** Conclusions GitHub reports for a completed run that should count as passing. */
const PASSING = new Set(["success", "skipped", "neutral"]);

/**
 * How many times validation may hand the same pull request back to the engineer.
 *
 * Bounds a loop nothing else bounds. `manage_dispatch_loop.ts`'s counter only
 * advances on a directive an agent wrote, and here the engineer is dispatched by
 * a workflow, so failing CI would otherwise cycle forever at the cost of a model
 * run per turn. Three is enough for a fix that needed another look and few enough
 * that a genuinely stuck pull request reaches a human quickly.
 */
export const CI_RETRY_LIMIT = 3;

export interface ValidationOutcome {
  /** Check runs to create, one per context the ruleset requires. */
  checks: { name: string; conclusion: "success" | "failure" }[];
  /** Agent to dispatch next, or "" to hand back to a human. */
  nextAgent: string;
  /** One line for the comment that accompanies a hand-back to the engineer. */
  summary: string;
}

/**
 * Translate a completed CI run into check runs and a next agent.
 *
 * `conclusion` is GitHub's own value for the dispatched run. An empty string
 * means the run never reached a conclusion — it timed out, was cancelled, or
 * could not be found. That is deliberately NOT treated as a failure to hand to
 * the engineer: there is no defect to fix, and dispatching one would spend a
 * model run discovering that. It writes a failing check, which blocks the merge,
 * and stops. A human reads the pull request and decides.
 */
export function decideValidationOutcome(
  conclusion: string,
  requiredContexts: string[],
  reviewerAgent: string,
  engineerAgent: string,
  priorRetries = 0,
): ValidationOutcome {
  const normalised = conclusion.trim().toLowerCase();
  const passed = PASSING.has(normalised);

  const checks = requiredContexts.map((name) => ({
    name,
    conclusion: (passed ? "success" : "failure") as "success" | "failure",
  }));

  if (passed) {
    return { checks, nextAgent: reviewerAgent, summary: `CI concluded ${normalised}.` };
  }

  if (!normalised) {
    return {
      checks,
      nextAgent: "",
      summary: "CI never reported a conclusion. Nothing was dispatched; a human should look.",
    };
  }

  if (priorRetries >= CI_RETRY_LIMIT) {
    return {
      checks,
      nextAgent: "",
      summary:
        `CI concluded ${normalised} after ${priorRetries} attempts at fixing it. ` +
        `Stopping rather than dispatching the engineer again; a human should look.`,
    };
  }

  return {
    checks,
    nextAgent: engineerAgent,
    summary: `CI concluded ${normalised}. Returning to the engineer with the failing job.`,
  };
}

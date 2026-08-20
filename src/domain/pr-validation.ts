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

/**
 * What this validation run concluded, as one of five distinguishable answers.
 *
 * `passed`                CI is green; the reviewer works next.
 * `failed`                CI is red and the engineer gets another attempt.
 * `no-conclusion`         the run timed out, was cancelled, or could not be found.
 * `retries-exhausted`     red again after `CI_RETRY_LIMIT` attempts; stop.
 * `deliverable-invalid`   the pull request would merge a `.github/atoma/` that
 *                        cannot start a run, so CI was never dispatched.
 */
export type ValidationVerdict = "passed" | "failed" | "no-conclusion" | "retries-exhausted" | "deliverable-invalid";

export interface ValidationOutcome {
  /**
   * What the run concluded.
   *
   * Returned rather than left for the caller to work out, because the caller
   * worked it out wrongly. It ran `checks.every((c) => c.conclusion === "success")`,
   * and `checks` holds one entry per required context — so on a base branch that
   * requires no status checks, `checks` is `[]`, `every()` is `true`, and a
   * failing CI run was read as a passing one.
   *
   * That case is not hypothetical: `validate_pull_request.ts` treats an empty
   * required list as legitimate and only warns. The consequences chained. The
   * failure comment was skipped while `nextAgent` still said `engineer`, so the
   * engineer was dispatched with no brief, no summary and no failing-run URL —
   * and that same comment is the retry tally, so `priorRetries` stayed at zero
   * and `CI_RETRY_LIMIT` could never fire. The engineer/CI loop this constant
   * exists to bound ran unbounded, one model run per turn.
   *
   * `lib/branch-rules.ts` records the same `[].every()` defect being fixed once
   * already. It was fixed at the input — "we could not read the required checks"
   * — and this is the other half: we read them, and there are none.
   */
  verdict: ValidationVerdict;
  /** Check runs to create, one per context the ruleset requires. */
  checks: { name: string; conclusion: "success" | "failure" }[];
  /** Agent to dispatch next, or "" to hand back to a human. */
  nextAgent: string;
  /** One line for the comment that accompanies a hand-back to the engineer. */
  summary: string;
}

/**
 * The run being judged, and who is available to work on it.
 *
 * An object rather than positional parameters because `reviewerAgent` and
 * `engineerAgent` are adjacent, same-typed, and mean opposite things: swapping
 * them type-checks, passes nothing, and inverts every routing decision this
 * function makes.
 */
export interface ValidationInput {
  /** GitHub's own conclusion for the dispatched run. Empty means it never reached one. */
  conclusion: string;
  /** The contexts the base branch's ruleset requires, one check run written per name. */
  requiredContexts: string[];
  /** Agent to dispatch when CI passes. */
  reviewerAgent: string;
  /** Agent to dispatch when CI fails and retries remain. */
  engineerAgent: string;
  /** How many times this pull request has already been handed back. */
  priorRetries?: number;
  /**
   * Ways the pull request's own `.github/atoma/` is inconsistent, from
   * `validate_deliverable.ts`. Empty is the normal case.
   *
   * Non-empty means CI was never dispatched, and the `conclusion` field is
   * therefore empty for a reason that has nothing to do with a run timing out.
   * That is why this is judged before `conclusion` is looked at: read in the
   * other order, a broken deliverable would report as `no-conclusion` — a
   * verdict that deliberately dispatches nobody, because there is no defect to
   * hand anyone. Here there is one, and its author is the agent that just wrote it.
   */
  deliverableProblems?: readonly string[];
}

/**
 * Translate a completed CI run into a verdict, check runs, and a next agent.
 *
 * An empty `conclusion` — the run timed out, was cancelled, or could not be
 * found — is deliberately NOT treated as a failure to hand to the engineer:
 * there is no defect to fix, and dispatching one would spend a model run
 * discovering that. It writes a failing check, which blocks the merge, and
 * stops. A human reads the pull request and decides.
 */
export function decideValidationOutcome(input: ValidationInput): ValidationOutcome {
  const { conclusion, requiredContexts, reviewerAgent, engineerAgent, priorRetries = 0 } = input;
  const failing = requiredContexts.map((name) => ({ name, conclusion: "failure" as const }));

  // Judged first, and treated exactly as a red CI run: failing checks so the
  // merge is blocked, a comment so the engineer knows what to fix, and the same
  // retry bound. Failing the workflow step instead would have written no check at
  // all, which leaves the required context pending forever and dispatches nobody
  // — a pull request only a human can rescue, for a mistake an agent makes in the
  // ordinary course of editing its own tool surface.
  //
  // The engineer can act on it because the run that carries it reads its
  // machinery from the default branch, not from this pull request: a broken
  // `.github/atoma/` here does not stop the agent sent to fix it.
  const deliverableProblems = input.deliverableProblems ?? [];
  if (deliverableProblems.length > 0) {
    const count = `${deliverableProblems.length} problem${deliverableProblems.length === 1 ? "" : "s"}`;
    if (priorRetries >= CI_RETRY_LIMIT) {
      return {
        verdict: "retries-exhausted",
        checks: failing,
        nextAgent: "",
        summary:
          `The deliverable is still not internally consistent (${count}) after ${priorRetries} attempts. ` +
          `Stopping rather than dispatching the engineer again; a human should look.`,
      };
    }
    return {
      verdict: "deliverable-invalid",
      checks: failing,
      nextAgent: engineerAgent,
      summary: `.github/atoma/ is not internally consistent (${count}), so CI was not run.`,
    };
  }

  const normalised = conclusion.trim().toLowerCase();
  const passed = PASSING.has(normalised);

  const checks = requiredContexts.map((name) => ({
    name,
    conclusion: (passed ? "success" : "failure") as "success" | "failure",
  }));

  if (passed) {
    return { verdict: "passed", checks, nextAgent: reviewerAgent, summary: `CI concluded ${normalised}.` };
  }

  if (!normalised) {
    return {
      verdict: "no-conclusion",
      checks,
      nextAgent: "",
      summary: "CI never reported a conclusion. Nothing was dispatched; a human should look.",
    };
  }

  if (priorRetries >= CI_RETRY_LIMIT) {
    return {
      verdict: "retries-exhausted",
      checks,
      nextAgent: "",
      summary:
        `CI concluded ${normalised} after ${priorRetries} attempts at fixing it. ` +
        `Stopping rather than dispatching the engineer again; a human should look.`,
    };
  }

  return {
    verdict: "failed",
    checks,
    nextAgent: engineerAgent,
    summary: `CI concluded ${normalised}. Returning to the engineer with the failing job.`,
  };
}

/**
 * serialization-guard.ts — the domain rule enforcing that at most one Atoma
 * agent Turn is ever active on a given WorkItem (Issue/PR) at a time.
 *
 * This module says nothing about GitHub, labels, or comments -- it is pure
 * decision logic, testable with plain objects. The actual MECHANISM that
 * enacts this decision (adding/removing the `atoma/in-progress` label,
 * deleting human comments made during the dispatch-to-label-landing gap)
 * lives in `src/scripts/manage_in_progress_label.ts` and
 * `src/scripts/guard_comment_during_run.ts` -- this is deliberately kept
 * separate from those so the RULE (when should the guard release?) has one
 * home, independent of HOW it is currently persisted via a GitHub label.
 *
 * Before this module existed, the rule below was expressed only as a
 * string-concatenated GitHub Actions `if:` expression inside
 * atoma-runner.wac.ts (`REMOVE_LABEL_GUARD`) -- untestable, unnamed, and
 * only readable by parsing bash-adjacent expression syntax.
 */

export interface TurnOutcomeSignals {
  /** Did the agent run itself complete successfully (as opposed to crashing/failing outright)? */
  succeeded: boolean;
  /** Explicit hand-back to a human: this run's own iteration budget was exhausted. */
  maxIterationsReached: boolean;
  /** Explicit hand-back to a human: the cross-run auto-dispatch loop's own safety limit was hit. */
  loopLimitReached: boolean;
  /** A tool call (launch_sub_agent / create_pr / merge_pr) already triggered an automatic follow-up dispatch during this run. */
  chainContinues: boolean;
  /** A text directive handing this WorkItem off to a specific next agent (empty string if none). */
  directive: string;
}

/**
 * True when the current Turn has reached a genuine stopping point for THIS
 * WorkItem, so the SerializationGuard should be released:
 *
 *   1. the run failed outright (cleanup, regardless of anything else)
 *   2. max_iterations was reached (explicit hand-back to a human)
 *   3. the auto-dispatch loop's own limit was reached (also an explicit,
 *      loop-limit-driven hand-back to a human)
 *   4. nothing further is happening at all: no tool call triggered a
 *      follow-up dispatch AND no text directive handed off to another
 *      agent -- this covers both a genuine completion/close and an agent
 *      escalating a question to a human.
 *
 * In every other case (a sub-agent was launched, a PR was created and
 * dispatched to review, a text directive handed off to the next agent)
 * the guard stays held, since work is still actively continuing --
 * possibly on a different WorkItem entirely -- under this one.
 */
export function shouldReleaseGuard(signals: TurnOutcomeSignals): boolean {
  if (!signals.succeeded) return true;
  if (signals.maxIterationsReached) return true;
  if (signals.loopLimitReached) return true;
  return !signals.chainContinues && signals.directive === "";
}

/**
 * completion-mention.ts — decides whether a finished run should pull a person in.
 *
 * The mention on a result comment means one thing: nothing else is going to
 * happen unless you do something. It is the only signal a person gets that work
 * has stopped, so it has to fire whenever work really has stopped — and stay
 * quiet whenever it has not, or it trains people to ignore it.
 *
 * Pure: the caller reads the run's outcome and the issue's state, this decides.
 */

export interface CompletionSignals {
  /** The agent's closing directive line, if it named another agent to run next. */
  directive?: string;
  /** A tool call during this run already dispatched a follow-up run. */
  chainContinues: boolean;
  /** The login to mention, empty when nobody is configured. */
  notify?: string;
  /** This issue was created by an agent as part of a larger one's plan. */
  isSubIssue: boolean;
  /** The issue is closed as of this comment. */
  issueClosed: boolean;
}

/**
 * Whether to append the "no agent will run next" mention.
 *
 * Three ways work continues without a person, and each silences the mention:
 *
 * - The agent handed off, naming the next agent in its directive.
 * - A tool call already dispatched the next run — `create_pr` starting the
 *   reviewer, `launch_sub_agent` starting the children.
 * - A closed sub-issue. Closing one is what wakes its parent: the aggregation
 *   gate re-invokes the parent's orchestrator once the last sibling lands, and
 *   until then the parent is what is waiting, not a person. The dispatch happens
 *   in a later workflow run, so `chainContinues` — which only sees this run —
 *   cannot know about it.
 *
 * A sub-issue that is still OPEN is deliberately not in that list. Nothing wakes
 * a parent for a sub-issue that has not finished, so a run that ends there has
 * genuinely stopped, and that is exactly the case a person needs to hear about.
 */
export function shouldMentionOnCompletion(signals: CompletionSignals): boolean {
  if (!signals.notify) return false;
  if (signals.directive) return false;
  if (signals.chainContinues) return false;
  if (signals.isSubIssue && signals.issueClosed) return false;
  return true;
}

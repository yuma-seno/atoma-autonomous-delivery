/**
 * handoff.ts — decision logic for the serial "Handoff" edge of the
 * multi-agent DAG that runs right after a PR merges: who (if anyone)
 * should be re-invoked to conclude the linked parent WorkItem, versus
 * closing it directly ourselves right now.
 *
 * This module says nothing about GitHub, `gh`, or dispatch mechanics --
 * pure decision, testable with plain objects. The actual mechanism (gh pr
 * merge, gh workflow run, closing the issue) lives in mcp/github.ts's
 * mergePr()/dispatchPostMergeAgent()/closeIssueAndDispatch().
 *
 * Before this module existed, this exact 4-way branch lived inline inside
 * mergePr(), interleaved with the `gh`/dispatch calls that carry it out --
 * readable only by tracing through a single large imperative function.
 */

export type PostMergeHandoff =
  | { kind: "no-parent" }
  | { kind: "already-closed"; parentIssue: number }
  | { kind: "reinvoke-origin-agent"; parentIssue: number; agent: string }
  | { kind: "close-directly"; parentIssue: number };

export interface PostMergeSignals {
  /** The parent WorkItem this merged PR is linked to, if any (from PARENT_ISSUE_TAG). */
  parentIssue: number | undefined;
  /** Is the parent already closed (e.g. GitHub's native "Closes #N" auto-close already succeeded)? */
  parentAlreadyClosed: boolean;
  /** The agent that originally created this PR, if tagged (from ORIGIN_AGENT_TAG). */
  originAgent: string | undefined;
}

/**
 * Decides what should happen to the parent WorkItem right after a PR
 * merges:
 *
 *   1. no linked parent at all -> nothing to do.
 *   2. the parent is already closed (native auto-close beat us to it) ->
 *      nothing to do -- re-invoking an agent to close an already-closed
 *      issue would be a pointless extra LLM call AND risks racing
 *      lib/aggregation.ts's idempotency marker against an independent
 *      event-driven aggregation path for the exact same completion.
 *   3. an origin agent is tagged -> prefer re-invoking THEM to confirm and
 *      close (they get a chance to give a final summary). The caller is
 *      still responsible for falling back to closing directly if that
 *      dispatch attempt itself fails -- this decision only expresses the
 *      PREFERRED handoff, not the outcome of attempting it.
 *   4. no origin agent tagged -> close the parent directly ourselves.
 */
export function decidePostMergeHandoff(signals: PostMergeSignals): PostMergeHandoff {
  if (signals.parentIssue === undefined) return { kind: "no-parent" };
  if (signals.parentAlreadyClosed) return { kind: "already-closed", parentIssue: signals.parentIssue };
  if (signals.originAgent) {
    return { kind: "reinvoke-origin-agent", parentIssue: signals.parentIssue, agent: signals.originAgent };
  }
  return { kind: "close-directly", parentIssue: signals.parentIssue };
}

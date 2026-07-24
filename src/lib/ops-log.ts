/**
 * ops-log.ts — Structured JSON-lines log of mutating operations Atoma
 * performs during a run, written to $ATOMA_OPS_LOG (default
 * /tmp/atoma_ops.log). Two purposes:
 *   1. A general audit trail (create_issue, close_issue, create_pr,
 *      merge_pr, etc. -- see mcp/github.ts's call sites).
 *   2. `logDispatch()`'s `"op":"dispatch"` entries are the canonical,
 *      STRUCTURED signal `atoma-runner.wac.ts`'s `chain_continues`
 *      detection reads (via `grep` for the literal `"op":"dispatch"`
 *      JSON key/value, a stable documented field -- not by pattern-matching
 *      arbitrary human-readable log prose). The previous approach (grepping
 *      stderr log TEXT for hand-written strings like "dispatched: agent=...")
 *      silently broke once already when a refactor changed the wording
 *      without updating the grep pattern to match -- this module exists so
 *      that class of bug can't recur: the dispatch signal now has one
 *      canonical writer and one canonical reader, both referring to the
 *      same `"op":"dispatch"` literal.
 */
import { appendFileSync } from "node:fs";

const OPS_LOG_PATH = process.env.ATOMA_OPS_LOG ?? "/tmp/atoma_ops.log";

export function logOp(op: string, payload: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), op, ...payload };
  try {
    appendFileSync(OPS_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error(`[ops-log] WARN: failed to write op log: ${e}`);
  }
}

/**
 * Records that a follow-up agent dispatch was triggered as a side effect of
 * a tool call during this run: `launch_sub_agent` (once per sub-issue),
 * `create_pr`'s automatic reviewer dispatch, `merge_pr`'s re-invocation of
 * the PR's origin agent (or, once that confirms and closes, the
 * orchestrator), and a sub-issue closure's orchestrator dispatch (see
 * lib/aggregation.ts). This is the ONE canonical "a chain continues"
 * signal every dispatch site writes.
 */
export function logDispatch(target: string, agent: string, extra: Record<string, unknown> = {}): void {
  logOp("dispatch", { target, agent, ...extra });
}

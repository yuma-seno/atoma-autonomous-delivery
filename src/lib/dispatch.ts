/**
 * dispatch.ts — start an agent run by dispatching the runner workflow.
 *
 * Four places hand work to another agent: an orchestrator launching sub-agents,
 * a created PR summoning its reviewer, a merged PR re-invoking the agent that
 * opened it, and the aggregation gate re-invoking an orchestrator once its
 * sub-issues are done. Each had built its own `gh workflow run` call, and the
 * copies had diverged in the two ways that matter.
 *
 * They disagreed on how the workflow is named -- `||`, `??`, a hardcoded
 * string, and a per-call option nothing ever passed.
 *
 * More seriously, two of them ignored the exit code and wrote the ops-log
 * dispatch entry unconditionally. That entry is not bookkeeping: it is the
 * signal `atoma-runner`'s `chain_continues` output reads to decide whether work
 * is still in flight, and `shouldReleaseGuard` keeps the `atoma/in-progress`
 * label held whenever it is set. So a dispatch that failed -- a bad token, a
 * renamed workflow, a rate limit -- reported a chain that had started when none
 * had, and left the issue locked with nothing on the way to unlock it.
 *
 * Binding the two together here is the point of this module: the ops-log entry
 * is written if and only if GitHub accepted the dispatch, and it cannot be
 * forgotten by the next call site added.
 */
import { dispatchWorkflow } from "./gh.ts";
import { logDispatch } from "./ops-log.ts";

/** The reusable workflow every agent run enters through. */
function runnerWorkflow(): string {
  return process.env.ATOMA_DISPATCH_WORKFLOW || "atoma-runner.yml";
}

export interface RunnerDispatch {
  /**
   * Prefixes both log lines, so a failure names who was dispatching and why.
   * Carry the detail here -- "re-invoking engineer on #12 to confirm and close"
   * -- rather than leaving it to the generic message.
   */
  context: string;
  agent: string;
  type: "issue" | "pr";
  number: number | string;
  /** Omit or leave empty when there is nobody to mention; a silent run is normal. */
  notify?: string;
  /**
   * Pass when the caller's working directory is not a checkout of the target
   * repository. The MCP servers run inside one and so may omit it; a helper
   * called from an arbitrary job should not assume that.
   */
  repo?: string;
  log?: (message: string) => void;
}

/**
 * Dispatch the runner. Returns whether GitHub accepted it -- callers that have
 * a fallback (closing an issue directly rather than asking an agent to) branch
 * on this; callers that do not should at least not treat failure as success.
 */
export function dispatchRunner(d: RunnerDispatch): boolean {
  const args = [
    ...(d.repo ? ["--repo", d.repo] : []),
    "--field", `agent=${d.agent}`,
    "--field", `number=${d.number}`,
    "--field", `type=${d.type}`,
    "--field", `notify=${d.notify ?? ""}`,
  ];
  if (!dispatchWorkflow(d.context, runnerWorkflow(), args, d.log)) return false;
  logDispatch(d.type, d.agent, { number: Number(d.number) });
  return true;
}

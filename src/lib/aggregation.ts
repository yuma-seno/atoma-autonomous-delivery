/**
 * aggregation.ts — the ONE canonical implementation of "check whether all
 * sub-issues of an orchestrated parent are done, and if so, dispatch the
 * orchestrator for re-invocation".
 *
 * Three call sites need this exact gate, previously reimplemented
 * independently (with subtly different retry/exclude/idempotency behavior)
 * in dispatch_orchestrator_if_ready.ts (atoma-side, post-close),
 * dispatch_if_siblings_done.ts (workflow-side, manual-close fallback), and
 * aggregate_sub_issues.ts (workflow-side, PR-merge primary path -- which
 * additionally injects sub-issue results into the orchestrator's session
 * before dispatching, via `beforeDispatch` below).
 *
 * Idempotency: two of the three call sites can race for the SAME
 * completion (a PR merge triggers both the event-driven
 * aggregate_sub_issues.ts AND, asynchronously, an origin-agent
 * re-invocation that eventually closes the sub-issue itself and reaches
 * dispatch_orchestrator_if_ready.ts) -- see the `atoma:aggregated` marker
 * check below, which makes whichever caller gets here first win and the
 * other a no-op.
 */
import { gh } from "./gh.ts";
import { countOpenSiblings } from "./sibling-check.ts";
import { resolveNotify } from "./notify.ts";
import { AGGREGATED_TAG, LLM_CONTEXT_TAG, PARENT_TAG, SUB_RESULT_TAG } from "./tags.ts";
import { logDispatch } from "./ops-log.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DispatchGateOptions {
  repo: string;
  parent: number;
  /** The sub-issue whose completion triggered this check. */
  closedNum: number;
  /**
   * Retry the sibling count with backoff (4 attempts) on GitHub
   * search-index eventual-consistency lag -- needed when called right
   * after OUR OWN close of `closedNum`, before the search index has
   * necessarily caught up.
   */
  retry?: boolean;
  /**
   * Exclude `closedNum` from the sibling count regardless of its live
   * open/closed state -- needed when called from a PR-merge event, where
   * `closedNum` may not be reflected as closed yet at all (native
   * "Closes #N" auto-close is unreliable under the Actions GITHUB_TOKEN).
   */
  exclude?: boolean;
  /** Progress-comment text posted when siblings remain. Omit to post nothing in that case (matches the manual-close fallback's original silent behavior). */
  progressMessage?: (remaining: number) => string;
  /** Run just before posting the "all done" comment + dispatching -- aggregate_sub_issues.ts uses this to inject sub-issue results into the orchestrator's persisted session first. */
  beforeDispatch?: () => Promise<void> | void;
  dispatchWorkflow?: string;
}

export interface DispatchGateResult {
  ready: boolean;
  remaining: number;
  dispatched: boolean;
}

export async function dispatchOrchestratorIfReady(opts: DispatchGateOptions): Promise<DispatchGateResult> {
  const excludeNum = opts.exclude ? opts.closedNum : undefined;
  let remaining = countOpenSiblings({ repo: opts.repo, parent: opts.parent, exclude: excludeNum });

  if (opts.retry) {
    for (let attempt = 1; remaining > 0 && attempt < 4; attempt++) {
      await sleep(2000 * attempt);
      remaining = countOpenSiblings({ repo: opts.repo, parent: opts.parent, exclude: excludeNum });
    }
  }

  if (remaining > 0) {
    if (opts.progressMessage) {
      gh(
        "issue", "comment", String(opts.parent), "--repo", opts.repo,
        "--body", `${LLM_CONTEXT_TAG.write("exclude")}\n${SUB_RESULT_TAG.write(opts.closedNum)}\n${opts.progressMessage(remaining)}`,
      );
    }
    return { ready: false, remaining, dispatched: false };
  }

  const { stdout: commentsOut } = gh(
    "issue", "view", String(opts.parent), "--repo", opts.repo,
    "--json", "comments", "--jq", ".comments[].body",
  );
  if (commentsOut.includes(AGGREGATED_TAG.write(opts.closedNum))) {
    // Another caller already handled this exact completion (see module doc
    // comment for the race this guards against).
    return { ready: true, remaining: 0, dispatched: false };
  }

  if (opts.beforeDispatch) await opts.beforeDispatch();

  gh(
    "issue", "comment", String(opts.parent), "--repo", opts.repo,
    "--body", `${AGGREGATED_TAG.write(opts.closedNum)}\nAtoma: All sub-tasks completed (last: #${opts.closedNum}). Re-invoking orchestrator for aggregation.`,
  );

  const notify = resolveNotify(opts.repo, opts.parent);
  gh(
    "workflow", "run", opts.dispatchWorkflow ?? "atoma-runner.yml",
    "--repo", opts.repo,
    "--field", "agent=orchestrator",
    "--field", `number=${opts.parent}`,
    "--field", "type=issue",
    "--field", `notify=${notify}`,
  );
  logDispatch("issue", "orchestrator", { number: opts.parent });

  return { ready: true, remaining: 0, dispatched: true };
}

/**
 * Resolves `subIssueNum`'s orchestrator parent from its own `atoma:parent`
 * tag, then runs the dispatch gate on it with retry enabled (GitHub's
 * search index is only eventually consistent -- the sub-issue we just
 * closed a moment ago may still be reported as open for a second or two).
 * No-ops (returns `{ready:false,remaining:0,dispatched:false}`) when
 * `subIssueNum` has no parent tag at all (not every closed issue is a
 * tracked Atoma sub-issue).
 *
 * The one canonical "a sub-issue just closed -- is its parent ready?"
 * entry point, used identically by mcp/github.ts's closeIssue() and
 * concludeIssue's bot-authored-issue branch (previously both
 * spawned the now-removed dispatch_orchestrator_if_ready.ts script).
 */
export async function dispatchOrchestratorIfSubIssueReady(repo: string, subIssueNum: number): Promise<DispatchGateResult> {
  const { code, stdout } = gh("issue", "view", String(subIssueNum), "--repo", repo, "--json", "body", "--jq", ".body");
  const body = code === 0 ? stdout : "";
  const parent = PARENT_TAG.read(body);
  if (parent === undefined) {
    console.error(`issue #${subIssueNum} has no atoma:parent tag, nothing to do`);
    return { ready: false, remaining: 0, dispatched: false };
  }
  return dispatchOrchestratorIfReady({ repo, parent, closedNum: subIssueNum, retry: true });
}

/**
 * sibling-check.ts — Count open sub-issues (siblings) still linked to a
 * parent issue. The one canonical implementation, used directly (no more
 * subprocess spawn) by lib/aggregation.ts's shared dispatch gate.
 */
import { gh } from "./gh.ts";
import { getLabel } from "./config.ts";
import type { GhIssueSummary } from "./types.ts";

export interface CountOpenSiblingsOptions {
  repo: string;
  parent: number;
  label?: string;
  launchedLabel?: string;
  /**
   * Drop this specific issue number from the count regardless of its live
   * open/closed state on GitHub -- used right after a PR merges its linked
   * sub-issue, when the caller already KNOWS that sub-issue's work is done
   * even though native "Closes #N" auto-close (or an async
   * re-invocation-driven close) may not have landed yet, so relying on the
   * live search index alone would under-report completion.
   */
  exclude?: number;
}

/**
 * Only counts siblings that have actually been dispatched (labeled
 * "launched"). Sub-issues created but not yet launched (e.g. a later phase
 * in a dependency-ordered plan) must NOT block re-invocation of the
 * orchestrator, otherwise the count can never reach zero.
 */
export function countOpenSiblings(opts: CountOpenSiblingsOptions): number {
  const label = opts.label || getLabel("sub_issue", "atoma/sub-issue");
  const launchedLabel = opts.launchedLabel || getLabel("launched", "atoma/launched");

  const { code, stdout, stderr } = gh(
    "issue", "list",
    "--repo", opts.repo,
    "--state", "open",
    "--label", label,
    "--label", launchedLabel,
    "--search", `atoma:parent=#${opts.parent} in:body`,
    "--json", "number",
  );

  if (code !== 0) {
    throw new Error(`countOpenSiblings: gh issue list failed: ${stderr}`);
  }

  const siblings = (stdout ? JSON.parse(stdout) : []) as GhIssueSummary[];
  const remaining = opts.exclude !== undefined ? siblings.filter((s) => s.number !== opts.exclude) : siblings;
  return remaining.length;
}

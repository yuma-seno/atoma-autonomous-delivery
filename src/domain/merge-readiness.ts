/**
 * merge-readiness.ts — decides whether a pull request may be merged, and says
 * why not when it may not.
 *
 * Branch protection would normally answer this, but it cannot be expressed in a
 * committed config file, so the gate lives where merges actually happen: this
 * decision, consumed both by `check_merge_readiness` (report) and `merge_pr`
 * (refuse). Keeping it here rather than inline in mcp/github.ts means the whole
 * truth table is testable against plain objects, with no `gh` in the loop.
 *
 * Deliberately fail-closed on "no checks ran at all". An agent branch is pushed
 * with GITHUB_TOKEN, which does not start workflow runs, so "no checks" is the
 * normal state of a fresh agent PR — treating it as passing would make the gate
 * decorative. The caller's job is to dispatch CI and come back.
 */

/** A single check run, reduced to what the decision needs. */
export interface CheckRun {
  name: string;
  /** GitHub `status`: queued | in_progress | completed. */
  status: string;
  /** GitHub `conclusion`, null while incomplete. */
  conclusion: string | null;
  detailsUrl?: string;
}

export interface MergeSignals {
  /** GitHub's `mergeable`: MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string;
  /** GitHub's `mergeStateStatus`, e.g. CLEAN | BLOCKED | DIRTY | BEHIND | UNSTABLE. */
  mergeStateStatus?: string;
  isDraft: boolean;
  state: string;
  checks: CheckRun[];
  /** `merge_policy` from config.json. */
  mergePolicy: string;
}

export type BlockerKind =
  | "not-open"
  | "draft"
  | "conflicting"
  | "mergeability-unknown"
  | "no-checks"
  | "checks-pending"
  | "checks-failing"
  | "merge-policy";

export interface Blocker {
  kind: BlockerKind;
  /** One line an agent can act on or relay to a human. */
  detail: string;
}

export interface MergeReadiness {
  ready: boolean;
  blockers: Blocker[];
  /** True when the only thing missing is a CI run on the head commit. */
  needsCiDispatch: boolean;
}

/** Conclusions that do not block a merge. A skipped or neutral check is not a failure. */
const PASSING = new Set(["success", "neutral", "skipped"]);

export function decideMergeReadiness(signals: MergeSignals): MergeReadiness {
  const blockers: Blocker[] = [];

  if (signals.state?.toUpperCase() !== "OPEN") {
    blockers.push({ kind: "not-open", detail: `pull request state is ${signals.state}, not OPEN` });
  }
  if (signals.isDraft) {
    blockers.push({ kind: "draft", detail: "pull request is a draft; mark it ready for review first" });
  }

  const mergeable = signals.mergeable?.toUpperCase();
  if (mergeable === "CONFLICTING") {
    blockers.push({
      kind: "conflicting",
      detail: "branch conflicts with the base; call github__sync_branch and resolve before merging",
    });
  } else if (mergeable !== "MERGEABLE") {
    // UNKNOWN means GitHub has not finished computing mergeability yet.
    blockers.push({
      kind: "mergeability-unknown",
      detail: `GitHub reports mergeable=${signals.mergeable ?? "null"}; retry shortly`,
    });
  }

  const completed = signals.checks.filter((c) => c.status === "completed");
  const incomplete = signals.checks.filter((c) => c.status !== "completed");
  const failing = completed.filter((c) => !PASSING.has((c.conclusion ?? "").toLowerCase()));

  if (signals.checks.length === 0) {
    blockers.push({
      kind: "no-checks",
      detail: "no check run exists for the head commit; CI must run before this can merge",
    });
  } else if (failing.length > 0) {
    for (const check of failing) {
      const where = check.detailsUrl ? ` (${check.detailsUrl})` : "";
      blockers.push({
        kind: "checks-failing",
        detail: `check "${check.name}" concluded ${check.conclusion}${where}`,
      });
    }
  } else if (incomplete.length > 0) {
    blockers.push({
      kind: "checks-pending",
      detail: `${incomplete.length} check(s) still running: ${incomplete.map((c) => c.name).join(", ")}`,
    });
  }

  if (signals.mergePolicy !== "auto") {
    blockers.push({
      kind: "merge-policy",
      detail: `merge_policy is '${signals.mergePolicy}', not 'auto'; a human performs the merge`,
    });
  }

  // Only worth dispatching CI when that is the sole obstacle -- dispatching on a
  // conflicting or draft PR just burns a run on a commit that has to change.
  const needsCiDispatch = blockers.length === 1 && blockers[0]?.kind === "no-checks";

  return { ready: blockers.length === 0, blockers, needsCiDispatch };
}

/** Render blockers as a numbered list for a tool result or an issue comment. */
export function formatBlockers(blockers: Blocker[]): string {
  return blockers.map((b, i) => `${i + 1}. [${b.kind}] ${b.detail}`).join("\n");
}

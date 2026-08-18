/**
 * issue-branch.ts — decides which branch an issue's work belongs on.
 *
 * Two questions, both pure: which existing branch a run should resume, and what
 * to call a new one. The I/O half — listing refs and asking GitHub which pull
 * requests merged — lives in the callers.
 *
 * The rule everything here follows is that a branch belongs to a unit of work,
 * not to an issue. An issue can produce a second piece of work after the first
 * has merged, and reusing the merged branch for it would build on a history the
 * base already contains.
 */

/** A branch that exists on the remote, and whether its work already landed. */
export interface IssueBranch {
  name: string;
  /** True when a pull request from this branch was merged. */
  merged: boolean;
}

/**
 * What may follow `atoma/issue-<n>` in a branch that issue owns.
 *
 * Anchored at both ends, which is the whole point. Unanchored, the remainder of
 * `atoma/issue-12-3` after the prefix for issue **1** is `2-3`, and a pattern
 * looking only for a trailing `-<digits>` finds one — so a run on issue 1 would
 * resume issue 12's branch, commit to it, and open a pull request from it.
 *
 * The check used to live in two places, the filter and the ordinal, each
 * unanchored in the same way. One arbiter now: an ordinal of 0 means the branch
 * is not this issue's, and nothing else decides ownership.
 */
const OWNED_SUFFIX = /^-(\d+)$/;

/** `""` -> 1 (the first), `"-3"` -> 3, anything else -> 0, meaning not owned. */
function ordinalOf(rest: string): number {
  if (rest === "") return 1;
  const match = OWNED_SUFFIX.exec(rest);
  return match ? Number(match[1]) : 0;
}

/** Every branch this issue owns, newest first. */
function ownedBranches(branches: IssueBranch[], issueNumber: number): { branch: IssueBranch; ordinal: number }[] {
  const prefix = `atoma/issue-${issueNumber}`;
  return branches
    .filter((branch) => branch.name.startsWith(prefix))
    .map((branch) => ({ branch, ordinal: ordinalOf(branch.name.slice(prefix.length)) }))
    .filter((entry) => entry.ordinal > 0)
    .sort((a, b) => b.ordinal - a.ordinal);
}

/**
 * The branch a run should check out, or "" to stay on the base branch.
 *
 * Returns the newest branch whose work has not merged, so a run that follows an
 * interrupted one continues where it stopped. Once everything has merged there
 * is nothing to resume, and staying on the base is what keeps a run that only
 * reports or closes something from creating a branch it will never commit to.
 */
export function branchToResume(branches: IssueBranch[], issueNumber: number): string {
  const unmerged = ownedBranches(branches, issueNumber).find((entry) => !entry.branch.merged);
  return unmerged?.branch.name ?? "";
}

/**
 * What to call the branch for work starting now.
 *
 * Only called when nothing is resumable, so every existing branch here has
 * merged and the name has to be a new one.
 *
 * Normally there are none: a merge deletes its branch, so `atoma/issue-N` is
 * free again and the common case stays readable. The suffix is for when one
 * survived anyway — a deletion that failed, or a merge made outside Atoma —
 * where reusing the name would build on history the base already contains. It
 * counts from the highest taken rather than from how many exist, so removing an
 * old branch cannot hand out a name that was already used.
 */
export function nextBranchName(branches: IssueBranch[], issueNumber: number): string {
  const prefix = `atoma/issue-${issueNumber}`;
  const owned = ownedBranches(branches, issueNumber);
  if (owned.length === 0) return prefix;
  return `${prefix}-${(owned[0]?.ordinal ?? 1) + 1}`;
}

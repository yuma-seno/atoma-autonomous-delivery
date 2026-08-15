/**
 * issue-branches.ts — lists an issue's branches as they exist on the remote.
 *
 * The I/O half of `domain/issue-branch.ts`: that module decides which branch to
 * resume and what to call a new one, this one goes and asks GitHub. Both callers
 * need it — the runner, to resume a branch before the agent starts, and the
 * GitHub MCP server, to name a branch at the first commit — and shared code
 * belongs here rather than in either of them, since a bundled script cannot
 * import another script's entry point.
 */
import { gh } from "./gh.ts";
import type { IssueBranch } from "../domain/issue-branch.ts";

function log(message: string): void {
  console.error(`[atoma-issue-branch] ${message}`);
}

/**
 * The remote branches that could belong to this issue, each marked with whether
 * its work merged.
 *
 * Scoped to one issue rather than listing every `atoma/issue-*` branch, because
 * the merged flag has to be asked for per branch and a repository accumulates
 * hundreds. `atoma/issue-12` also matches `atoma/issue-120` here; separating
 * them is `domain/issue-branch.ts`'s job, and over-collecting is the safe
 * direction.
 *
 * Merged is read from the pull requests rather than from git ancestry: a squash
 * merge leaves no ancestry to follow, so a branch whose work is in the base
 * would still look unmerged — and a run that believed that would resume a branch
 * whose commits are already released.
 *
 * Returns what it managed to learn rather than throwing. A caller that cannot
 * list branches should start from the base branch, not stop the run.
 */
export function collectIssueBranches(repo: string, issueNumber: number): IssueBranch[] {
  const refs = gh("api", `repos/${repo}/git/matching-refs/heads/atoma/issue-${issueNumber}`);
  if (refs.code) {
    log(`WARN could not list branches: ${refs.stderr || refs.stdout}`);
    return [];
  }

  let names: string[];
  try {
    const parsed = JSON.parse(refs.stdout || "[]") as { ref: string }[];
    names = parsed.map((entry) => entry.ref.replace(/^refs\/heads\//, ""));
  } catch {
    log("WARN branch list was not valid JSON");
    return [];
  }

  const owner = repo.split("/", 1)[0] ?? "";
  return names.map((name) => ({ name, merged: headBranchMerged(repo, owner, name) }));
}

/**
 * Whether any pull request from this branch was merged.
 *
 * Asks by head branch instead of scanning the repository's pull requests: that
 * list is paginated newest-first, so a branch whose pull request has since
 * fallen off the first page would read as unmerged. The number of branches one
 * issue owns is small, and this is only reached for those.
 */
function headBranchMerged(repo: string, owner: string, branch: string): boolean {
  const prs = gh("api", `repos/${repo}/pulls?state=all&per_page=100&head=${owner}:${branch}`);
  if (prs.code) {
    log(`WARN could not read pull requests for ${branch}; treating it as unmerged`);
    return false;
  }
  try {
    const parsed = JSON.parse(prs.stdout || "[]") as { merged_at?: string | null }[];
    return parsed.some((pr) => Boolean(pr.merged_at));
  } catch {
    log(`WARN pull request list for ${branch} was not valid JSON`);
    return false;
  }
}

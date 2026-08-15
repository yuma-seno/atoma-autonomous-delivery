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
 * Remote `atoma/issue-*` branches, each marked with whether its work merged.
 *
 * Merged is read from the pull requests rather than from git ancestry: a squash
 * merge leaves no ancestry to follow, so a branch whose work is in the base
 * would still look unmerged.
 *
 * Returns what it managed to learn rather than throwing. A caller that cannot
 * list branches should start on the base branch, not stop the run.
 */
export function collectIssueBranches(repo: string): IssueBranch[] {
  const refs = gh("api", `repos/${repo}/git/matching-refs/heads/atoma/issue-`);
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

  // One query for every pull request whose head is one of these branches, rather
  // than one per branch. A repository accumulates these, and asking per branch
  // would cost a request each on every run.
  const prs = gh("api", `repos/${repo}/pulls?state=all&per_page=100`);
  const mergedHeads = new Set<string>();
  if (prs.code) {
    log("WARN could not read pull requests; treating every branch as unmerged");
  } else {
    try {
      const parsed = JSON.parse(prs.stdout || "[]") as { head?: { ref?: string }; merged_at?: string | null }[];
      for (const pr of parsed) {
        if (pr.merged_at && pr.head?.ref) mergedHeads.add(pr.head.ref);
      }
    } catch {
      log("WARN pull request list was not valid JSON");
    }
  }

  return names.map((name) => ({ name, merged: mergedHeads.has(name) }));
}

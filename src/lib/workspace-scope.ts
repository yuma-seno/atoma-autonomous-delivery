/**
 * workspace-scope.ts — walk to the root issue whose workspace a run shares.
 *
 * The I/O half of `domain/workspace.ts`'s `workspaceScope`, which holds the rule.
 * Here is the walking: one hop at a time through `parentIssueOf`, and for a pull
 * request one extra hop first, because a pull request's link to its issue is the
 * `atoma:parent-issue` tag rather than a sub-issue relationship.
 */
import { gh } from "./gh.ts";
import { parentIssueOf } from "./parent-issue.ts";
import { PARENT_ISSUE_TAG } from "./tags.ts";
import { workspaceScope, type WorkspaceScope } from "../domain/workspace.ts";

/**
 * How far up the chain to walk.
 *
 * Six, matching `lib/notify.ts`'s walk. A cycle is impossible through GitHub's own
 * sub-issue links but not through the body tag, which anything can write -- and an
 * unbounded walk on a cycle is a run that never starts.
 */
const MAX_HOPS = 6;

function log(message: string): void {
  console.error(`[atoma-workspace] ${message}`);
}

/** The issue a pull request was opened for, or undefined when it says nothing. */
function issueOfPullRequest(repo: string, number: number): number | undefined {
  const { code, stdout } = gh("pr", "view", String(number), "--repo", repo, "--json", "body", "--jq", ".body");
  if (code) {
    log(`WARN could not read pull request #${number}`);
    return undefined;
  }
  return PARENT_ISSUE_TAG.read(stdout);
}

/**
 * Which issue's workspace this run shares.
 *
 * A read that fails is reported and turns into a private workspace rather than a
 * borrowed one -- see `domain/workspace.ts` for why that direction. The `why` it
 * returns is what the caller logs, so a run working alone when it should have been
 * sharing says so instead of looking normal.
 */
export function resolveWorkspaceScope(repo: string, type: string, number: string | number): WorkspaceScope {
  const target = Number(number);
  if (!Number.isFinite(target) || target <= 0) {
    return workspaceScope(number, [], `"${number}" is not an issue or pull request number`);
  }

  const chain: number[] = [];
  let current = target;

  if (type === "pr") {
    const issue = issueOfPullRequest(repo, target);
    if (issue === undefined) {
      // A pull request with no issue tag is its own root. Ordinary for one a person
      // opened, so it is not a failure -- but it also means no sharing, which is
      // why it is said out loud.
      log(`#${target} names no parent issue; its workspace is its own`);
      return workspaceScope(number, []);
    }
    chain.push(issue);
    current = issue;
  }

  const visited = new Set<number>([target]);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (visited.has(current) && hop > 0) {
      log(`WARN parent chain revisits #${current}; stopping the walk here`);
      break;
    }
    visited.add(current);

    const parentage = parentIssueOf(repo, current);
    if (!parentage.known) {
      // Everything read so far still counts. A chain that broke three hops up is
      // more precise than falling all the way back to the target, and the tests
      // pin that: the root reached is the answer, not the failure.
      return workspaceScope(number, chain, chain.length > 0 ? "" : parentage.why);
    }
    if (parentage.parent === 0) break;
    chain.push(parentage.parent);
    current = parentage.parent;
  }

  const scope = workspaceScope(number, chain);
  if (!scope.resolved) log(`WARN ${scope.why}; using this target's own workspace`);
  else if (scope.rootIssue !== String(number)) log(`sharing issue #${scope.rootIssue}'s workspace`);
  return scope;
}

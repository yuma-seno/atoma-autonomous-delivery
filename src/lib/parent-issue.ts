/**
 * parent-issue.ts — the one reader for "which issue is this one a child of".
 *
 * There were three, and they disagreed. `branch-placement.ts` read the body's
 * `atoma:parent` tag; `aggregation.ts` read the same tag through its own copy of
 * the same `gh` call; `scripts/resolve_orchestrator_parent.ts` issued its own
 * GraphQL query for GitHub's native sub-issue `parent` field and fell back to the
 * tag. Nothing recorded why one of the three had the richer rule.
 *
 * The richer rule is the right one and is now everyone's. GitHub's own parent
 * link is authoritative when it exists, and the tag is what Atoma writes itself
 * -- an issue created by `create_issue` carries the tag whether or not the native
 * link was established, and `addSubIssue` is best-effort.
 *
 * Not `issueLinks`, which answers a much larger question: it pulls fifty children
 * and fifty pull requests, and every caller here wants one number.
 */
import { gh, ghGraphql } from "./gh.ts";
import { PARENT_TAG } from "./tags.ts";

/**
 * What an issue's parentage turned out to be.
 *
 * Three answers, not two. `known: true, parent: 0` is a root issue; `known:
 * false` is a read that failed, and the two are not interchangeable -- one
 * caller can treat an unknown parent as absent and another cannot. See
 * `stackedPrBase` in `branch-placement.ts` for the case that cannot: it decides
 * where a pull request merges to, and guessing lands one child's half of a
 * feature on the release branch.
 */
export type ParentIssue = { known: true; parent: number } | { known: false; why: string };

function log(message: string): void {
  console.error(`[atoma-parent] ${message}`);
}

/** GitHub's native sub-issue parent, or undefined when there is none or it could not be asked. */
function nativeParent(repo: string, issue: number): number | undefined {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) return undefined;
  try {
    const data = ghGraphql<{ repository: { issue: { parent: { number: number } | null } } }>(
      "query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){parent{number}}}}",
      { owner, repo: name, num: issue },
    );
    return data.repository.issue.parent?.number;
  } catch {
    // Not an answer either way: the field is unavailable on some plans and the
    // query fails on a transient error. The tag below is the fallback, and it is
    // the one Atoma writes for itself.
    return undefined;
  }
}

/**
 * The parent issue this one was split out of.
 *
 * GitHub's native link first, then the `atoma:parent` tag `create_issue` writes.
 * A failure to read the body is `known: false`; a body with no tag and no native
 * parent is a root issue.
 */
export function parentIssueOf(repo: string, issue: number): ParentIssue {
  const native = nativeParent(repo, issue);
  if (native) return { known: true, parent: native };

  const { code, stderr, stdout } = gh("issue", "view", String(issue), "--repo", repo, "--json", "body", "--jq", ".body");
  if (code) {
    const why = `could not read issue #${issue}: ${stderr.trim() || `gh exited ${code}`}`;
    log(`WARN ${why}`);
    return { known: false, why };
  }
  return { known: true, parent: PARENT_TAG.read(stdout) ?? 0 };
}

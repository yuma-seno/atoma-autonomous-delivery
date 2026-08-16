/**
 * issue-links.ts — reads an issue's relationships out of GitHub.
 *
 * One GraphQL request per issue covers all of it: the parent and children come
 * from GitHub's sub-issues, which `create_issue` establishes through
 * `addSubIssue` and which a person gets for free by using the sub-issue control
 * in the web UI; the pull requests come from two places that have to be unioned,
 * for the reason `claimsToClose` explains.
 *
 * Nothing here reads an Atoma marker. The relationships have to survive an
 * issue a person opened, decomposed and closed without an agent ever touching
 * it, and markers only exist where an agent has been.
 */
import { ghGraphql } from "./gh.ts";
import { claimsToClose, dedupeByNumber, type IssueLinks, type LinkedIssue, type LinkedPr } from "../domain/issue-links.ts";

/** How many children and pull requests to ask for. Past this the reader is not reading, they are scrolling. */
const LINK_LIMIT = 50;

interface GqlIssue {
  number: number;
  title: string;
  state: string;
}

interface GqlPr extends GqlIssue {
  merged: boolean;
  body: string;
}

interface GqlIssueLinks {
  parent: GqlIssue | null;
  subIssues: { nodes: GqlIssue[] };
  closedByPullRequestsReferences: { nodes: GqlPr[] };
  timelineItems: { nodes: { source?: GqlPr }[] };
}

interface GqlResponse {
  repository?: { issue?: GqlIssueLinks | null } | null;
}

const QUERY = `
query($owner:String!, $name:String!, $number:Int!, $limit:Int!) {
  repository(owner:$owner, name:$name) {
    issue(number:$number) {
      parent { number title state }
      subIssues(first:$limit) { nodes { number title state } }
      closedByPullRequestsReferences(first:$limit, includeClosedPrs:true) {
        nodes { number title state merged body }
      }
      timelineItems(last:$limit, itemTypes:[CROSS_REFERENCED_EVENT]) {
        nodes { ... on CrossReferencedEvent { source { ... on PullRequest { number title state merged body } } } }
      }
    }
  }
}`;

function normalise(node: GqlIssue): LinkedIssue {
  return { number: node.number, title: node.title, state: node.state.toLowerCase() };
}

function asPr(node: GqlPr): LinkedPr {
  return { ...normalise(node), merged: Boolean(node.merged) };
}

/**
 * One issue's parent, children and pull requests.
 *
 * Returns empty links rather than throwing when GitHub cannot be reached: this
 * decorates a read that has already succeeded, and failing the whole read
 * because the decoration failed would be a poor trade.
 */
export function issueLinks(repo: string, number: number): IssueLinks {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return { children: [], pullRequests: [] };

  let issue: GqlIssueLinks | null = null;
  try {
    issue = ghGraphql<GqlResponse>(QUERY, { owner, name, number, limit: LINK_LIMIT }).repository?.issue ?? null;
  } catch (error) {
    console.error(`[atoma-github] WARN could not read links for #${number}: ${(error as Error).message}`);
    return { children: [], pullRequests: [] };
  }
  if (!issue) return { children: [], pullRequests: [] };

  // GitHub's own closing links first — where they exist they are authoritative.
  // Then the cross-reference timeline, filtered to pull requests that say they
  // close this issue, which is the only way a sub-issue's stacked pull request
  // appears at all.
  const declared = issue.closedByPullRequestsReferences.nodes.map(asPr);
  const referenced = issue.timelineItems.nodes
    .map((node) => node.source)
    .filter((source): source is GqlPr => Boolean(source?.number) && claimsToClose(source?.body ?? "", number))
    .map(asPr);

  return {
    parent: issue.parent ? normalise(issue.parent) : undefined,
    children: issue.subIssues.nodes.map(normalise),
    pullRequests: dedupeByNumber(declared, referenced),
  };
}

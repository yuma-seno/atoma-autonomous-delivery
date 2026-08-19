/**
 * issue-links.ts — what an issue is attached to, and which attachments count.
 *
 * The relationships an issue has are the difference between reading a comment
 * correctly and reading it wrong. "Implemented it" on a sub-issue means a part
 * was implemented, not the feature. "We decided X" reads as settled when the
 * pull request carrying X is merged, and as a proposal when it is still open.
 * Neither is recoverable from the comment text.
 *
 * These are read from GitHub's own relationships rather than from Atoma's
 * markers, because an issue a person drove by hand has no Atoma markers on it
 * and is exactly the case that must not silently come back empty.
 *
 * Pure. The GraphQL half lives in `lib/issue-links.ts`.
 */

export interface LinkedIssue {
  number: number;
  title: string;
  /** GitHub's state, lowercased: "open" or "closed". */
  state: string;
}

export interface LinkedPr extends LinkedIssue {
  /**
   * Whether it landed.
   *
   * Separate from `state` because GitHub says only `closed` for both a merged
   * pull request and an abandoned one, and those mean opposite things to
   * someone reading "we decided to do X" in the discussion above.
   */
  merged: boolean;
}

export interface IssueLinks {
  parent?: LinkedIssue;
  children: LinkedIssue[];
  pullRequests: LinkedPr[];
  /**
   * Why the links could not be read, when they could not.
   *
   * Absent means the lists above are the answer. Present means they are empty
   * because nobody could look, which is a different fact -- and the one
   * `get_issue_comments`' header rests its whole value on: "'Implemented it'
   * on a sub-issue whose pull request is still open is a proposal, not a
   * fact." A failed read silently produced exactly the reading that comment
   * exists to prevent.
   *
   * Not throwing stays right -- this decorates a read that already succeeded.
   * Reporting the degradation is the part that was missing.
   */
  unavailable?: string;
}

/**
 * GitHub's closing keywords, as GitHub documents them.
 *
 * Matching these ourselves is not a preference for reinventing the parser. It
 * is the only way to see a sub-issue's pull request at all: GitHub forms its
 * own closing link only for pull requests that target the default branch, and
 * Atoma aims a sub-issue's pull request at its parent's branch. Measured on
 * this repository, #281's `Closes #281` in PR #284 produced no native link
 * because #284 targeted `atoma/issue-280`, while #280's did because its pull
 * request targeted `main`.
 */
const CLOSING_KEYWORDS = "close[sd]?|fix(?:e[sd])?|resolve[sd]?";

/**
 * Whether a pull request body claims to close this issue.
 *
 * Used to tell the pull request doing the work from one that merely mentioned
 * the issue in passing — a distinction the cross-reference timeline does not
 * make, and `willCloseTarget` does not answer either: it reports `false` for
 * #284 despite the `Closes #281` in its body.
 */
export function claimsToClose(body: string, issue: number): boolean {
  return new RegExp(`\\b(?:${CLOSING_KEYWORDS})\\s*:?\\s+#${issue}\\b`, "i").test(body);
}

/**
 * The issue a pull request body claims to close, if it claims to close one.
 *
 * The same keywords as [`claimsToClose`], asked the other way round: that one is given
 * a number, this one finds it. Both exist because two callers need different questions
 * of one rule, and until now the second caller wrote its own `/Closes #(\d+)/` —
 * case-sensitive, one space, one keyword. A body saying `closes #12` matched the
 * injector that decides whether to ADD such a line (case-insensitive, so it added
 * nothing) and did not match the parser, so `sub_number` came out empty and every job
 * gated on it was skipped: the parent was never notified and the sub-issue's results
 * never reached the orchestrator's session. Green, and silent.
 */
export function closedIssueNumber(body: string): number | undefined {
  const match = new RegExp(`\\b(?:${CLOSING_KEYWORDS})\\s*:?\\s+#(\\d+)\\b`, "i").exec(body);
  return match ? Number(match[1]) : undefined;
}

/** Combine link lists from several sources, first mention of a number winning. */
export function dedupeByNumber<T extends { number: number }>(...lists: T[][]): T[] {
  const seen = new Map<number, T>();
  for (const list of lists) for (const item of list) if (!seen.has(item.number)) seen.set(item.number, item);
  return [...seen.values()].sort((a, b) => a.number - b.number);
}

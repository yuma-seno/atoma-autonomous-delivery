/**
 * comment-range.ts — which of an issue's comments a read returns, and the one
 * line that says so.
 *
 * Four defaults interact here: `from` alone means one comment, `to` alone means
 * a window ending there, neither means the end of the conversation, and every
 * bound is clamped to what exists. That is a truth table, and it was written
 * inline in `mcp/github.ts` where nothing could test it.
 *
 * The arithmetic had a hole. `from: 10` on a four-comment issue produced
 * `to = 4`, `from = 10`, an empty selection, and the sentence
 * "comment(s) 10-4 of 4; pass from/to to read the rest" — a backwards range, no
 * comments, and an invitation to read the rest of nothing. That case is real:
 * `search__search_issues` reports a comment number, and comments get deleted
 * between the index being built and the read happening.
 *
 * The rule this module keeps is the one already stated at the call site: always
 * say what was shown and of how many, because a truncated read that looks
 * complete is how a caller concludes something is absent when it was merely not
 * shown. An empty selection has to say why it is empty, or it reads as "there is
 * nothing there".
 */

/**
 * How many comments come back when the caller did not ask for a range.
 *
 * Small on purpose. An unbounded read is how a single lookup buries a run's
 * context under a conversation it did not need, and the whole reason
 * `search__search_issues` reports which comment it matched is so that a caller
 * with a specific question asks a specific range.
 */
export const DEFAULT_COMMENT_WINDOW = 5;

export interface CommentRange {
  /** 1-based index of the first comment to return. Meaningless when `count` is 0. */
  from: number;
  /** 1-based inclusive index of the last. Meaningless when `count` is 0. */
  to: number;
  /** How many comments the range covers. Zero is a real answer, not a failure. */
  count: number;
  /** One line naming exactly what was shown, and of how many. Never empty. */
  showing: string;
}

const EMPTY = (showing: string): CommentRange => ({ from: 0, to: 0, count: 0, showing });

/**
 * Decide which comments to return.
 *
 * `total` is how many the issue actually has; `from` and `to` are the caller's
 * request, both optional and both 1-based inclusive.
 */
export function selectCommentRange(total: number, from?: number, to?: number): CommentRange {
  if (total <= 0) return EMPTY("this issue has no comments");

  // Asked for a comment past the end. Said plainly, because the caller usually
  // got this number from a search result and the honest answer is that the
  // comment is gone, not that the issue is quiet.
  if (from !== undefined && from > total) {
    return EMPTY(`there is no comment ${from}; this issue has ${total}`);
  }
  if (to !== undefined && to < 1) {
    return EMPTY(`\`to\` was ${to}; comments are numbered from 1, and this issue has ${total}`);
  }
  if (from !== undefined && to !== undefined && to < from) {
    return EMPTY(`\`from\` (${from}) is after \`to\` (${to}), so the range covers nothing`);
  }

  // Without a range: the end of the conversation, because a caller who does not
  // name a comment wants to know where things stand, and the beginning is what
  // the body already covers. With `from` alone: that one comment.
  const last = Math.min(to ?? from ?? total, total);
  const first = Math.max(1, from ?? last - DEFAULT_COMMENT_WINDOW + 1);
  const count = last - first + 1;

  return {
    from: first,
    to: last,
    count,
    showing:
      count === total
        ? `all ${total} comment(s)`
        : `comment(s) ${first}-${last} of ${total}; pass from/to to read the rest`,
  };
}

/**
 * progress.ts — stopping a chain that is not getting anywhere, rather than one
 * that is merely long.
 *
 * # Why a count of runs is the wrong thing to count
 *
 * #480 put a limit on consecutive handoffs, and it is worth having, but a count of
 * runs is a proxy and a poor one in both directions. #362 spent 2,299k tokens and
 * **finished the work**; a pointless loop can spend 30k and finish nothing. Cutting
 * on volume stops the large legitimate job and lets the small useless one run.
 *
 * The direct signal is simpler: **did the run change anything?** An engineer that
 * ran and pushed nothing changed nothing. Two of those in a row is repetition, and
 * it fires sooner than any run-count limit while leaving a long piece of real work
 * alone.
 *
 * # Counted from the comments, not stored
 *
 * The same discipline as `dispatch-chain.ts`, and for the reason its own comment
 * gives: the counter that used to live in `session.json` could not reach 1, because
 * it reset on any new event and every run posts a comment. So each result comment
 * carries what the run did (`CHANGED_TAG`), and this walks backwards over them.
 *
 * # What ends the walk
 *
 * Anything that is not an agent result comment saying it changed nothing. A
 * person's comment, a comment from the machinery -- "PR #N created" -- or a result
 * comment that did change something, all stop it.
 *
 * That is deliberately generous. A run that ends by creating a pull request posts
 * no result comment at all (its tool posts one instead), so its progress would
 * otherwise be invisible and the runs either side of it would look consecutive.
 * Stopping at anything unrecognised means this under-fires rather than over-fires,
 * and under-firing is the right direction: the cost of missing one loop is some
 * wasted runs, and the cost of interrupting real work is real work interrupted.
 */
import type { ChainComment } from "./dispatch-chain.ts";

/**
 * How many consecutive runs may change nothing before a person is asked.
 *
 * Two. One run that changes nothing is ordinary -- an agent that investigated and
 * reported, or one that was asked a question. Two in a row, with nothing else
 * happening in between, is the shape of an agent going round.
 *
 * Exported because the comment a person receives names it, and a literal spliced
 * in somewhere else is how that message comes to quote a number that is not the
 * limit in force.
 */
export const DEFAULT_NO_PROGRESS_LIMIT = 2;

/**
 * Consecutive agent result comments, newest first, that report changing nothing.
 *
 * `comments` oldest first, as the API returns them. `isNoChangeResult` is passed in
 * so the tag format stays in `lib/tags.ts` and this stays a pure function of its
 * inputs.
 */
export function runsWithoutChange(
  comments: readonly ChainComment[],
  isNoChangeResult: (body: string) => boolean,
): number {
  let runs = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (!isNoChangeResult(comments[i]?.body ?? "")) break;
    runs++;
  }
  return runs;
}

/**
 * Whether enough runs have changed nothing to stop and ask.
 *
 * `>=`, like `handoffLimitReached`: a limit of 2 allows two and refuses the
 * dispatch that would start a third. The run that hits it still finishes and still
 * reports; only the handoff is withheld.
 */
export function noProgressLimitReached(runs: number, limit: number): boolean {
  return runs >= limit;
}

/**
 * A limit from configuration, or the default.
 *
 * Zero and negatives mean the default rather than "never stop", matching every
 * other limit here -- see `resolveHandoffLimit` for why one rule about zero across
 * the whole project is worth more than a cleverer rule in one place.
 */
export function resolveNoProgressLimit(configured: unknown): number {
  const value = Number(configured);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_NO_PROGRESS_LIMIT;
}

export interface StopDecision {
  stop: boolean;
  /** The sentence a person reads, naming which limit stopped it. */
  reason?: string;
}

/**
 * Which limit stopped the chain, if either did, and what to tell the person.
 *
 * One function rather than two conditions in the workflow, because the message and
 * the decision have to agree. They did not before: the escalation comment was built
 * from the handoff count whatever the reason, so a second limit added beside it
 * would have told a person their chain was too long when it was not.
 *
 * The no-progress limit is checked first when both are reached. It is the more
 * specific statement -- "the last two runs changed nothing" says what to look at,
 * where "five handoffs" only says how many there were.
 */
export function stopReason(counts: {
  handoffs: number;
  handoffLimit: number;
  runsWithoutChange: number;
  noProgressLimit: number;
}): StopDecision {
  if (noProgressLimitReached(counts.runsWithoutChange, counts.noProgressLimit)) {
    return {
      stop: true,
      reason:
        `The last ${counts.runsWithoutChange} agent runs changed nothing — no commit was pushed by any of them ` +
        `(limit ${counts.noProgressLimit}). Repeating a run that changes nothing is unlikely to start changing something, ` +
        `so the next automatic handoff has been withheld.`,
    };
  }
  if (counts.handoffs >= counts.handoffLimit) {
    return {
      stop: true,
      reason:
        `Auto-dispatch loop limit reached: ${counts.handoffs} agent handoffs since anyone else commented ` +
        `(limit ${counts.handoffLimit}). To prevent unintended infinite agent loops and excessive API costs, ` +
        `the next automatic handoff has been withheld.`,
    };
  }
  return { stop: false };
}

/**
 * dispatch-chain.ts — how many times agents have handed work to each other with
 * nobody else saying anything.
 *
 * ## What this replaced, and why it could not fire
 *
 * The count used to live in `session.json`, advanced by `manage_dispatch_loop.ts`,
 * and reset whenever the run saw a new GitHub event. It never reached 1.
 *
 * The reset was meant to say "a person intervened, so start counting again". What
 * it actually said was "anything appeared in the issue" -- and `post_result_comment`
 * posts one comment per run. The next agent in the chain sees the previous agent's
 * result comment as a new event, resets to zero, hands off, and so on. `LOOP_LIMIT`
 * was unreachable, the comment telling a person the chain had stopped could not be
 * posted, and `decide_guard_release` always received `loop-limit-reached=false`.
 *
 * Its unit tests were green. Three of the four passed `newEventCount = 0`, which
 * the workflow cannot produce: the agent step only runs when `new_event_count != 0`,
 * and when it does not run the loop-control step is skipped along with it. The
 * branch that incremented the counter was covered and unreachable at the same time.
 *
 * ## Counting rather than storing
 *
 * `CI_RETRY_LIMIT` is the only cross-run limit in this repository that works, and
 * its own comment says why: it is "counted from its own comments rather than held
 * anywhere, so it survives a re-dispatch and needs no state of its own".
 *
 * So this does the same. Walk the target's comments from the newest backwards,
 * stop at the first one a person wrote, and count the agent result comments in
 * between. There is no counter to reset, no session field to migrate, and no
 * input a test can pass that the workflow could not.
 *
 * `post_result_comment` runs before the loop-control step, so the current run's own
 * comment is already there and is included. A tally of 1 means "this run, and
 * nothing before it".
 *
 * ## Issue and pull request count separately, on purpose
 *
 * A chain that moves from an issue to a pull request starts again from zero,
 * because the comments are on a different object. That is the right answer rather
 * than a gap: opening a pull request IS progress. The point is to catch repetition
 * that goes nowhere, not to cap how long a legitimate piece of work may take.
 */

/** The subset of a GitHub comment this decision reads. */
export interface ChainComment {
  /** `user.type` from the comments API: `"User"`, `"Bot"`, `"Organization"`, ... */
  authorType?: string;
  /** The comment body, which carries the agent tag if an agent wrote it. */
  body?: string;
}

/**
 * How many consecutive handoffs may happen with nobody but agents talking.
 *
 * Five, because the longest chain measured in this repository's history is three,
 * and that history is one where a person intervenes often. Left running on its
 * own the chains get longer, which is why `limits.agent_handoffs` exists -- this is
 * the value for a repository that has not thought about it yet.
 *
 * Exported because the comment a person receives when a chain stops names the
 * number. That sentence used to carry its own literal `5`, so raising the limit
 * would have told them "loop limit (5 consecutive runs) reached" while the real
 * limit was something else, on the one message they get.
 */
export const DEFAULT_HANDOFF_LIMIT = 5;

/**
 * Whether a person wrote this comment.
 *
 * True only for `"User"`. `"Bot"`, `"Organization"`, an unrecognised value and a
 * missing one all read as not-a-person, and that asymmetry is deliberate: the two
 * mistakes cost different amounts.
 *
 * Reading a bot as a person resets the tally, which is the defect this module
 * exists to fix -- the limit silently never fires. Reading a person as a bot makes
 * the limit fire early, which escalates to a person. One failure hides a runaway
 * chain; the other interrupts a working one. So the uncertain cases go to the side
 * that interrupts.
 *
 * `user.type` rather than a `[bot]` suffix on the login, because the suffix is part
 * of a name anyone can choose and the type is what the API decides.
 */
function isPerson(comment: ChainComment): boolean {
  return comment.authorType === "User";
}

/**
 * Agent result comments since the last one a person wrote.
 *
 * `comments` in the order the API returns them -- oldest first. `isAgentComment`
 * is passed in rather than imported so this stays a pure function of its inputs
 * and the tag format lives in one place (`lib/tags.ts`).
 */
export function handoffsSincePerson(
  comments: readonly ChainComment[],
  isAgentComment: (body: string) => boolean,
): number {
  let handoffs = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    // A person's comment ends the walk rather than being counted. Everything
    // before it belongs to a chain that has already been interrupted.
    if (isPerson(comment)) break;
    if (isAgentComment(comment.body ?? "")) handoffs++;
  }
  return handoffs;
}

/**
 * Whether the chain has gone on long enough to stop and ask a person.
 *
 * `>=` rather than `>`: a limit of 5 means five handoffs are allowed and the
 * dispatch that would make a sixth is refused. The run that hits it still finishes
 * and still reports -- only the handoff to the next agent is withheld.
 */
export function handoffLimitReached(handoffs: number, limit: number): boolean {
  return handoffs >= limit;
}

/**
 * A limit from configuration, or the default.
 *
 * Zero and negatives mean the default rather than "no chains allowed", matching
 * every other limit in this project: `infra::timeouts` in atoma made that the rule
 * for timeouts after three call sites took `0` literally, and a reader who learns
 * it in one place should not be surprised in another. A repository that wants no
 * automatic handoffs at all turns `auto_triggers` off, which says so.
 */
export function resolveHandoffLimit(configured: unknown): number {
  const value = typeof configured === "number" ? configured : Number(configured);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_HANDOFF_LIMIT;
}

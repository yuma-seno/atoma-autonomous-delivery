/**
 * session-size.ts — keeping a session inside the model's context window.
 *
 * # The failure this exists for
 *
 * A session accumulates across runs, because `session_mode: continue` restores
 * the history on purpose. Past the model's window the provider answers `400`,
 * and nothing in atoma retries that -- it retries 429, 5xx and a truncated body.
 * So the run fails, the session stays as it was, and the next run fails for the
 * same reason. Forever.
 *
 * That is not a risk. Three of the stored sessions were already past 128k when
 * this was written, and for those issues that agent could never run again.
 *
 * # What is actually big, measured over 345 sessions and 5,666 tool calls
 *
 * ```text
 *   tool RESULTS   13.5 MB   59.2%
 *   tool CALLS      2.3 MB   10.0%     <- a sixth of the results
 *   everything else 7.0 MB   30.7%
 * ```
 *
 * One result's size: `p50 277  p75 1,372  p90 3,630  p99 20,083  max 823,859`
 * characters. **The largest 1% is most of the weight**, which is why a cap works
 * and why dropping by recency alone does not: in the worst session, a single
 * 823,859-character result sat inside the most recent twenty.
 *
 * # Two operations, at two different moments
 *
 * `capToolResults` runs when a session is SAVED, so it never grows in the first
 * place. `replaceOldToolResults` runs when a session is RESTORED and is still too
 * big, which after capping is the exception -- measured, 2 of 343.
 *
 * # Why the tool CALLS survive both
 *
 * The previous version dropped each result together with the `tool_calls` that
 * produced it. So an agent resuming lost the record of **what it had already
 * looked at** -- and #544 measured what that costs: a run that made 169 distinct
 * searches and reported nothing. An agent that cannot see what it searched
 * searches again.
 *
 * Keeping the calls costs almost nothing. In the worst session it is 25 KB
 * against 2,717 KB of results: **1%** of what dropping the results saves.
 *
 * # The one structural rule
 *
 * A `tool` message answers an assistant message's `tool_calls`, and every provider
 * rejects a conversation where one appears without the other. Neither operation
 * here removes a message, so the pairing cannot be broken by either -- which is
 * the same invariant `answer_unanswered_tool_calls` enforces in the core.
 */
import type { Session, SessionMessage } from "../lib/session.ts";

/**
 * How much of one tool result is kept in a saved session.
 *
 * 4,000 characters, and the number is where the curve turns. Measured across all
 * 5,666 stored results:
 *
 * ```text
 *   cap      total tokens   over 100k   results left whole
 *   none      5,422,514         7       5666/5666
 *    1000     2,991,796         0       3889/5666 (68.6%)
 *    4000     3,686,213         2       5154/5666 (91.0%)
 *    8000     4,021,523         3       5441/5666 (96.0%)
 * ```
 *
 * Going down to 1,000 saves 19% more and costs 22 points of results left whole;
 * going up to 8,000 buys 5 points and costs 9% more storage. 4,000 also lands on
 * the measured `p90` of 3,630, so nine results in ten are untouched.
 *
 * And it is enough to be useful: 1,000 characters of head and 3,000 of tail holds
 * a build log's errors and its summary. At a 1,000 cap the tail is 750 characters,
 * which cuts a stack trace in half.
 *
 * Deliberately fixed rather than configurable, for the reason `SESSION_TOKEN_LIMIT`
 * is not per-model: a knob invites tuning without measurement. Changing it should
 * mean bringing a measurement.
 */
export const TOOL_RESULT_CAP = 4_000;

/**
 * How much of one tool call's arguments is kept.
 *
 * Far higher than the result cap because the arguments are what the agent ASKED
 * for, and a truncated request reads as a different request. Measured, they are
 * small: `p50 114  p90 362  p99 3,828`. Exactly one call in 5,666 exceeded 20,000
 * characters — a `filesystem__write_file`.
 *
 * So this is not a compression measure. It is a bound, so that one pathological
 * call cannot defeat everything else here.
 */
export const TOOL_CALL_ARGS_CAP = 20_000;

/**
 * How many of the most recent tool results keep their content when a restored
 * session is still too big.
 *
 * Not a size decision. Measured, the difference between keeping none and keeping
 * twenty is 1–14% of the session, because the cap and the replacement do the work:
 *
 * ```text
 *   keepRecent:      0        5       10       20      all
 *      67,721   67,853   68,060   68,468  110,825   issue-174-engineer
 *      38,121   39,096   39,918   42,729  104,318   issue-399/engineer-1
 * ```
 *
 * It is a decision about how much of "where was I" a resumed run gets. Everything
 * restored is from a PREVIOUS run and therefore stale, which argues for few; but
 * the last few results are exactly what a run stopped by `/stop` needs in order not
 * to start over, which argues for some. Ten is roughly the last two or three turns
 * of work.
 */
export const KEEP_RECENT_RESULTS = 10;

/**
 * Above this many estimated tokens, a restored session is shrunk before use.
 *
 * 100k, against the smallest window in common use (128k). The gap is the run's
 * own additions -- the system prompt, the GitHub context reconciled in front of
 * it, and whatever this run says -- which land after this decision is made.
 *
 * Deliberately not per-model. Reading the window of whichever model an agent
 * happens to name would be more precise and would put a table of model names in
 * this repository that is wrong the week a new one ships.
 */
export const SESSION_TOKEN_LIMIT = 100_000;

/** Four characters to a token, the estimate #457 measured with. */
const CHARS_PER_TOKEN = 4;

/**
 * Roughly how many tokens a session costs, from its serialised size.
 *
 * An under-count for Japanese, where a character is closer to a token than to a
 * quarter of one -- which is the right direction to be wrong in: it makes the
 * threshold fire sooner on exactly the sessions this repository produces.
 */
export function estimateTokens(session: Session): number {
  const messages = session.messages ?? [];
  if (messages.length === 0) return 0;
  return Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN);
}

/** What a shrink did, for the log and for the notice the agent reads. */
export interface ShrinkOutcome {
  shrunk: boolean;
  tokensBefore: number;
  tokensAfter: number;
  /** How many tool results had their content replaced or shortened. */
  changed: number;
}

export interface ShrinkResult extends ShrinkOutcome {
  session: Session;
}

/** The text of a tool message, whatever shape it is stored in. */
function contentText(content: SessionMessage["content"]): string | undefined {
  if (typeof content === "string") return content;
  return undefined;
}

/**
 * Keep the head and the tail of `text`, up to `limit` characters.
 *
 * The same rule as `domain/tool-output.ts` and the core's `domain::tool_output`,
 * deliberately: three caps behaving differently would be three things to learn.
 * A quarter at the front and the rest at the back, because a command's exit
 * status, a stack trace's origin and a test summary are all at the end.
 */
export function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const dropped = text.length - limit;
  return (
    text.slice(0, head) +
    `\n\n[atoma] ${dropped} characters dropped from the middle; ${limit} shown\n\n` +
    text.slice(text.length - tail)
  );
}

/** The text left where a tool result used to be. */
export function removedResultNotice(originalLength: number): string {
  return (
    `[atoma] This result (${originalLength} characters) was removed so the session fits in the ` +
    "model's context window. The call that produced it is still above — call it again if you need it."
  );
}

/**
 * Shorten every oversized tool result and tool-call argument. Removes nothing.
 *
 * For the moment a session is SAVED. A session that never grows needs no rescuing
 * later, and this is the cheaper place to do it: measured over all stored
 * sessions, capping at save time takes them from 5,422k to 3,686k estimated
 * tokens and leaves 2 of 343 above the restore threshold.
 */
export function capToolResults(session: Session, limit = TOOL_RESULT_CAP): ShrinkResult {
  const messages = session.messages ?? [];
  const tokensBefore = estimateTokens(session);
  let changed = 0;

  const kept = messages.map((message) => {
    if (message.role === "tool") {
      const text = contentText(message.content);
      if (text === undefined || text.length <= limit) return message;
      changed += 1;
      return { ...message, content: capText(text, limit) };
    }
    const calls = message.tool_calls;
    if (!Array.isArray(calls)) return message;

    let touched = false;
    const capped = calls.map((call) => {
      const fn = (call as { function?: { arguments?: unknown } }).function;
      const args = fn?.arguments;
      if (typeof args !== "string" || args.length <= TOOL_CALL_ARGS_CAP) return call;
      touched = true;
      return { ...call, function: { ...fn, arguments: capText(args, TOOL_CALL_ARGS_CAP) } };
    });
    if (!touched) return message;
    changed += 1;
    return { ...message, tool_calls: capped };
  });

  if (changed === 0) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, changed: 0 };
  }
  const out: Session = { ...session, messages: kept };
  return { session: out, shrunk: true, tokensBefore, tokensAfter: estimateTokens(out), changed };
}

/**
 * Replace the content of every tool result except the most recent few.
 *
 * For the moment a session is RESTORED and is still too big. Nothing is removed:
 * the `tool` message stays, so its `tool_calls` stays valid, and the agent keeps
 * the complete record of what it called even where it can no longer see what came
 * back.
 */
export function replaceOldToolResults(
  session: Session,
  keepRecent = KEEP_RECENT_RESULTS,
): ShrinkResult {
  const messages = session.messages ?? [];
  const tokensBefore = estimateTokens(session);

  const resultIndexes = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const replaceBefore = resultIndexes[resultIndexes.length - keepRecent] ?? Infinity;

  let changed = 0;
  const kept = messages.map((message, i) => {
    if (message.role !== "tool" || i >= replaceBefore) return message;
    const text = contentText(message.content);
    // A result already short enough to be worth keeping is kept: replacing 40
    // characters with a 150-character notice would make the session bigger.
    if (text === undefined || text.length <= 200) return message;
    changed += 1;
    return { ...message, content: removedResultNotice(text.length) };
  });

  if (changed === 0) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, changed: 0 };
  }
  const out: Session = { ...session, messages: [...kept, shrinkNotice(changed)] };
  return { session: out, shrunk: true, tokensBefore, tokensAfter: estimateTokens(out), changed };
}

/**
 * What the agent is told, once, at the end of what is left.
 *
 * A `user` message because that is the role the runner already uses to put
 * context in front of an agent (`reconcile_github_session.ts` does the same for
 * GitHub events), and because an agent treats its own past assistant turns as
 * things it said rather than things it was told.
 *
 * The sentence that matters is the second one. The calls are still there, so the
 * agent knows what it looked at and needs to re-fetch only what it still needs --
 * which is the difference between this and the version that dropped both halves.
 */
export function shrinkNotice(changed: number): SessionMessage {
  return {
    role: "user",
    content: [
      `[atoma] The contents of ${changed} earlier tool results were removed from this session so it`,
      "fits in the model's context window.",
      "",
      "The calls themselves are still here, so you can see what you already looked at. What is gone is",
      "what came back: file contents, command output, search results. Call again for the ones you still",
      "need — do not answer from memory of something you can no longer see.",
    ].join("\n"),
    atoma_metadata: { source: "atoma", layer: "session-shrink", changed },
  };
}

/**
 * Shrink a restored session if it is too big to run with, and say what happened.
 *
 * Returns the session unchanged when it fits, which is nearly every time: the
 * median stored session is 21k, and with save-time capping in place only 2 of 343
 * ever reach here.
 */
export function shrinkIfNeeded(session: Session, limit = SESSION_TOKEN_LIMIT): ShrinkResult {
  const tokensBefore = estimateTokens(session);
  if (tokensBefore <= limit) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, changed: 0 };
  }
  return replaceOldToolResults(session);
}

/** One line for the run log, or nothing when nothing happened. */
export function shrinkLogLine(outcome: ShrinkOutcome, what = "tool results replaced"): string | undefined {
  if (!outcome.shrunk) return undefined;
  return (
    `session shrunk: ${outcome.changed} ${what}, ` +
    `~${Math.round(outcome.tokensBefore / 1000)}k -> ~${Math.round(outcome.tokensAfter / 1000)}k estimated tokens`
  );
}

/**
 * The case this strategy cannot fix, named rather than left to fail silently.
 *
 * If a session is still too big once the tool output is gone, what is left is the
 * conversation, and nothing here can shorten that. #539 is where deciding what to
 * do about it lives; this is the line a person sees in the meantime, and it names
 * the way out because "accept the limit" should not mean "fail every run from now
 * on with a provider error nobody connects to this".
 */
export function stillTooBigLine(
  outcome: ShrinkOutcome,
  limit = SESSION_TOKEN_LIMIT,
): string | undefined {
  if (outcome.tokensAfter <= limit) return undefined;
  return (
    `session is still ~${Math.round(outcome.tokensAfter / 1000)}k estimated tokens after shrinking, ` +
    `over the ~${Math.round(limit / 1000)}k this run allows. What is left is the conversation itself, ` +
    "which nothing here can shorten. This run will likely be refused by the provider; start the agent " +
    "again with a recover run (for example `/engineer recover`), which archives the session and begins fresh."
  );
}

/**
 * session-size.ts — keeping a session inside the model's context window.
 *
 * # The failure this exists for
 *
 * A session accumulates across runs, because `session_mode: continue` restores
 * the history on purpose. Past the model's window the provider answers `400`,
 * and nothing in atoma retries that -- it retries 429, 5xx and a truncated body.
 * So the run fails, **the session is only saved on success and therefore stays as
 * it was**, and the next run fails for the same reason. Forever.
 *
 * That is not a risk. Three of the 343 stored sessions were already past 128k
 * when this was written, and for those issues that agent could never run again.
 *
 * # What is actually big, measured
 *
 * Across all 343 stored sessions, **68% of the bytes are tool results and the
 * `tool_calls` that produced them.** In the worst one it is not 68% but 99%:
 *
 * ```
 *   sessions/issue-190/engineer.json   706k estimated tokens
 *     tool        696k
 *     assistant     7k
 *     system        2k
 *     user          1k
 * ```
 *
 * Dropping that one category takes every over-window session under every window:
 *
 * ```
 *   706k -> 3k     284k -> 8k     226k -> 5k
 *   over 128k: 3 sessions -> 0
 * ```
 *
 * The conversation itself is a few thousand tokens. #457 called "the discussion
 * genuinely got that long" a limit to accept; measured, that case has not
 * happened once. What happens is a shell server returning a build log.
 *
 * # Why not summarise
 *
 * Because this needs no model call, and so has no summary quality to argue about.
 * What it costs is that the agent must read a file again rather than recall it,
 * which is why the marker below says so in as many words: a model that half
 * remembers a file it can no longer see is worse than one that knows to re-read.
 *
 * # The one structural rule
 *
 * A `tool` message answers an assistant message's `tool_calls`, and every provider
 * rejects a conversation where one appears without the other. So both halves go
 * together, always -- an assistant turn that had nothing but a tool call is dropped
 * whole, because once the call is gone it says nothing.
 */
import type { Session, SessionMessage } from "../lib/session.ts";

/**
 * Above this many estimated tokens, a restored session is shrunk before use.
 *
 * 100k, against the smallest window in common use (128k). The gap is the run's
 * own additions -- the system prompt, the GitHub context reconciled in front of
 * it, and whatever this run says -- which land after this decision is made.
 *
 * Deliberately not per-model. Reading the window of whichever model an agent
 * happens to name would be more precise and would put a table of model names in
 * this repository that is wrong the week a new one ships. The cost of shrinking a
 * session that would have fit is that an agent re-reads a file; the cost of not
 * shrinking one that does not fit is an issue that can never be worked again.
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
  /** How many messages were removed outright. */
  removed: number;
}

export interface ShrinkResult extends ShrinkOutcome {
  session: Session;
}

/** Whether a message says anything once its tool calls are gone. */
function hasText(content: SessionMessage["content"]): boolean {
  if (typeof content === "string") return content.trim() !== "";
  return Array.isArray(content) && content.length > 0;
}

/**
 * What the agent is told, once, at the end of what is left.
 *
 * A `user` message because that is the role the runner already uses to put
 * context in front of an agent (`reconcile_github_session.ts` does the same for
 * GitHub events), and because an agent treats its own past assistant turns as
 * things it said rather than things it was told.
 */
export function shrinkNotice(removed: number): SessionMessage {
  return {
    role: "user",
    content: [
      `[atoma] ${removed} earlier tool results were removed from this session so it fits in the model's context window.`,
      "",
      "Your own messages are unchanged, so what you concluded is still here. What is gone is what the tools returned:",
      "file contents, command output, search results. If you need any of it, call the tool again — do not answer from",
      "memory of something you can no longer see.",
    ].join("\n"),
    atoma_metadata: { source: "atoma", layer: "session-shrink", removed },
  };
}

/**
 * Drop tool traffic from a session, keeping the conversation.
 *
 * Unconditional -- `shrinkIfNeeded` is what decides whether to call it. Split that
 * way so the rule and the threshold can be read, and tested, apart.
 */
export function dropToolTraffic(session: Session): ShrinkResult {
  const messages = session.messages ?? [];
  const tokensBefore = estimateTokens(session);
  const kept: SessionMessage[] = [];
  let removed = 0;

  for (const message of messages) {
    if (message.role === "tool") {
      removed += 1;
      continue;
    }
    if (message.tool_calls === undefined) {
      kept.push(message);
      continue;
    }
    // The other half of the pair. Keeping the assistant's own words is the point
    // of doing this rather than summarising, so the message survives whenever it
    // said anything besides making the call.
    const { tool_calls: _dropped, ...rest } = message;
    if (hasText(rest.content)) {
      kept.push(rest as SessionMessage);
    } else {
      removed += 1;
    }
  }

  if (removed === 0) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, removed: 0 };
  }

  kept.push(shrinkNotice(removed));
  const shrunkSession: Session = { ...session, messages: kept };
  return {
    session: shrunkSession,
    shrunk: true,
    tokensBefore,
    tokensAfter: estimateTokens(shrunkSession),
    removed,
  };
}

/**
 * Shrink a restored session if it is too big to run with, and say what happened.
 *
 * Returns the session unchanged when it fits, which is nearly every time: the
 * median stored session is 21k.
 */
export function shrinkIfNeeded(session: Session, limit = SESSION_TOKEN_LIMIT): ShrinkResult {
  const tokensBefore = estimateTokens(session);
  if (tokensBefore <= limit) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, removed: 0 };
  }
  return dropToolTraffic(session);
}

/**
 * One line for the run log, or nothing when nothing happened.
 *
 * Worth saying out loud even though the agent is told separately: the person
 * reading a run needs to know why the agent is re-reading files it had read, and
 * a session that shrank and said nothing anywhere is the kind of thing that gets
 * diagnosed twice.
 */
export function shrinkLogLine(outcome: ShrinkOutcome): string | undefined {
  if (!outcome.shrunk) return undefined;
  return (
    `session shrunk: ${outcome.removed} tool messages dropped, ` +
    `~${Math.round(outcome.tokensBefore / 1000)}k -> ~${Math.round(outcome.tokensAfter / 1000)}k estimated tokens`
  );
}

/**
 * The case this strategy cannot fix, named rather than left to fail silently.
 *
 * If a session is still too big once the tool output is gone, what is left is the
 * conversation, and nothing here can shorten that. #457 called this the limit to
 * accept, and it is -- but "accept" should not mean "fail every run from now on
 * with a provider error nobody connects to this". The way out exists and is one
 * command, so the line says which.
 *
 * Not measured in any stored session: the largest conversation left after
 * shrinking was 11k against a 100k threshold.
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

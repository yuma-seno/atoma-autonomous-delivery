import { describe, expect, test } from "bun:test";
import type { Session, SessionMessage } from "../lib/session.ts";
import {
  dropToolTraffic,
  estimateTokens,
  SESSION_TOKEN_LIMIT,
  shrinkIfNeeded,
  shrinkNotice,
  stillTooBigLine,
} from "./session-size.ts";

function session(messages: SessionMessage[]): Session {
  return { messages, metadata: { github_context: { agent: "engineer" } } };
}

/** A session over the threshold, made of the thing that actually makes them big. */
function bigSession(): Session {
  const messages: SessionMessage[] = [
    { role: "system", content: "You are engineer." },
    { role: "user", content: "Fix the failing test." },
  ];
  for (let n = 0; n < 40; n += 1) {
    messages.push({
      role: "assistant",
      content: n % 2 === 0 ? `Reading file ${n}.` : "",
      tool_calls: [{ id: `call-${n}`, type: "function", function: { name: "read", arguments: "{}" } }],
    });
    messages.push({ role: "tool", tool_call_id: `call-${n}`, content: "x".repeat(20_000) });
  }
  return session(messages);
}

describe("how big a session is", () => {
  test("an empty session costs nothing", () => {
    expect(estimateTokens({ messages: [] })).toBe(0);
    expect(estimateTokens({})).toBe(0);
  });

  test("the estimate grows with what is stored", () => {
    const small = estimateTokens(session([{ role: "user", content: "hi" }]));
    const large = estimateTokens(session([{ role: "user", content: "x".repeat(40_000) }]));
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(9_000);
  });
});

describe("shrinking a session that will not fit", () => {
  /**
   * Nearly every session. The median stored one is 21k, and touching those would
   * cost an agent the file it read two minutes ago for no reason at all.
   */
  test("a session under the limit is returned exactly as it was", () => {
    const before = session([
      { role: "user", content: "small" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "result" },
    ]);
    const result = shrinkIfNeeded(before);
    expect(result.shrunk).toBe(false);
    expect(result.session).toBe(before);
    expect(result.removed).toBe(0);
  });

  test("over the limit, the tool traffic goes and the conversation stays", () => {
    const result = shrinkIfNeeded(bigSession());
    expect(result.shrunk).toBe(true);
    expect(result.tokensBefore).toBeGreaterThan(SESSION_TOKEN_LIMIT);
    expect(result.tokensAfter).toBeLessThan(SESSION_TOKEN_LIMIT);

    const kept = result.session.messages ?? [];
    expect(kept.some((m) => m.role === "tool"), "no tool results survive").toBe(false);
    expect(kept.some((m) => m.tool_calls !== undefined), "and no calls without them").toBe(false);
    expect(kept[0]?.content, "the prompt prefix is untouched").toBe("You are engineer.");
    expect(kept.some((m) => m.content === "Fix the failing test."), "what was asked survives").toBe(true);
    expect(kept.some((m) => m.content === "Reading file 0."), "and what the agent said").toBe(true);
  });

  /**
   * The structural rule. A `tool` message answers an assistant turn's
   * `tool_calls`, and a provider rejects either half without the other -- so a
   * shrink that produced one would trade "too big to run" for "malformed and will
   * never run", which is the same outcome by a different route.
   */
  test("neither half of a tool pair is left behind", () => {
    const kept = dropToolTraffic(bigSession()).session.messages ?? [];
    for (const message of kept) {
      expect(message.role).not.toBe("tool");
      expect(message.tool_calls).toBeUndefined();
    }
  });

  /**
   * An assistant turn that was nothing but a tool call says nothing once the call
   * is gone, and an empty assistant message is itself rejected by some providers.
   */
  test("an assistant turn with only a call is dropped, one with words is kept", () => {
    const result = dropToolTraffic(
      session([
        { role: "assistant", content: "I will read the file.", tool_calls: [{ id: "c1" }] },
        { role: "tool", tool_call_id: "c1", content: "contents" },
        { role: "assistant", content: "", tool_calls: [{ id: "c2" }] },
        { role: "tool", tool_call_id: "c2", content: "more contents" },
      ]),
    );
    const kept = result.session.messages ?? [];
    const assistants = kept.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe("I will read the file.");
    // Two tool results and one wordless assistant turn.
    expect(result.removed).toBe(3);
  });

  /**
   * A model that half-remembers a file it can no longer see is worse than one that
   * knows to look again, so the notice says which of the two it is in.
   */
  test("the agent is told, in the role it reads as being told", () => {
    const kept = dropToolTraffic(bigSession()).session.messages ?? [];
    const notice = kept[kept.length - 1];
    expect(notice?.role).toBe("user");
    expect(String(notice?.content)).toContain("call the tool again");
    expect(String(notice?.content)).toContain("do not answer from");
    expect(notice?.atoma_metadata?.layer).toBe("session-shrink");
  });

  test("the notice counts what went", () => {
    expect(String(shrinkNotice(42).content)).toContain("42 earlier tool results");
  });

  /**
   * A long conversation with no tool traffic has nothing this can take, and must
   * not gain a notice saying it lost something.
   */
  test("a session with nothing to drop is left alone and says so", () => {
    const talk = session([
      { role: "system", content: "You are engineer." },
      { role: "user", content: "x".repeat(500_000) },
    ]);
    const result = shrinkIfNeeded(talk);
    expect(result.tokensBefore).toBeGreaterThan(SESSION_TOKEN_LIMIT);
    expect(result.shrunk, "there is nothing here that this strategy can remove").toBe(false);
    expect(result.session.messages).toHaveLength(2);
  });

  /**
   * The limit #457 said to accept. Accepting it should still not mean failing
   * every run from now on with a provider error nobody connects to this, so the
   * one way out is named where somebody reading the run will see it.
   */
  test("a session that is still too big afterwards says what to do about it", () => {
    const talk = session([{ role: "user", content: "x".repeat(500_000) }]);
    const result = shrinkIfNeeded(talk);
    const line = stillTooBigLine(result);
    expect(line, "over the limit with nothing droppable left").toBeDefined();
    expect(line).toContain("recover");
  });

  test("and an ordinary session says nothing", () => {
    const result = shrinkIfNeeded(session([{ role: "user", content: "small" }]));
    expect(stillTooBigLine(result)).toBeUndefined();
  });

  test("everything else about the session is carried through", () => {
    const result = shrinkIfNeeded(bigSession());
    expect(result.session.metadata?.github_context?.agent).toBe("engineer");
  });
});

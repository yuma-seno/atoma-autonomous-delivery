import { describe, expect, test } from "bun:test";
import type { Session, SessionMessage } from "../lib/session.ts";
import {
  capText,
  capToolResults,
  estimateTokens,
  KEEP_RECENT_RESULTS,
  replaceOldToolResults,
  SESSION_TOKEN_LIMIT,
  shrinkIfNeeded,
  shrinkNotice,
  stillTooBigLine,
  TOOL_CALL_ARGS_CAP,
  TOOL_RESULT_CAP,
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

const toolIds = (s: Session) =>
  (s.messages ?? []).filter((m) => m.role === "tool").map((m) => m.tool_call_id);
const callIds = (s: Session) =>
  (s.messages ?? [])
    .flatMap((m) => (Array.isArray(m.tool_calls) ? m.tool_calls : []))
    .map((c) => (c as { id?: string }).id);

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

describe("capText", () => {
  test("text within the limit is untouched", () => {
    expect(capText("short", 100)).toBe("short");
  });

  /**
   * The end is where a command's exit status, a stack trace's origin and a test
   * summary are. Keeping only the beginning throws away what failed.
   */
  test("both ends survive and the tail gets the larger share", () => {
    const capped = capText("A".repeat(500) + "Z".repeat(500), 100);
    expect(capped.startsWith("AAAA")).toBe(true);
    expect(capped.endsWith("ZZZZ")).toBe(true);
    expect((capped.match(/A/g) ?? []).length).toBe(25);
    expect((capped.match(/Z/g) ?? []).length).toBe(75);
  });

  /**
   * A truncated result that does not say it is truncated is worse than a short
   * one: a grep that matched everything and a file that contains nothing read
   * the same.
   */
  test("the marker says how much went", () => {
    expect(capText("x".repeat(1000), 100)).toContain("900 characters dropped from the middle");
  });
});

describe("capping a session on the way to disk", () => {
  test("an oversized result is shortened and its pair is untouched", () => {
    const before = session([
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "x".repeat(50_000) },
    ]);
    const result = capToolResults(before);

    expect(result.shrunk).toBe(true);
    expect(result.changed).toBe(1);
    expect(String(result.session.messages?.[1]?.content).length).toBeLessThan(TOOL_RESULT_CAP + 200);
    expect(toolIds(result.session)).toEqual(["c1"]);
    expect(callIds(result.session)).toEqual(["c1"]);
  });

  /**
   * Nine results in ten are already under the cap (measured p90 = 3,630), and
   * rewriting a session that needed nothing is a diff for a reviewer to read for
   * no reason.
   */
  test("a session with nothing oversized is returned exactly as it was", () => {
    const before = session([
      { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]);
    const result = capToolResults(before);
    expect(result.shrunk).toBe(false);
    expect(result.session).toBe(before);
  });

  /**
   * Not compression -- a bound. Measured, exactly one call in 5,666 had arguments
   * over 20,000 characters, and the point is that it cannot defeat everything else.
   */
  test("a pathological argument is bounded too", () => {
    const before = session([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "write_file", arguments: "y".repeat(80_000) } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "written" },
    ]);
    const result = capToolResults(before);
    expect(result.shrunk).toBe(true);
    const args = (result.session.messages?.[0]?.tool_calls as { function: { arguments: string } }[])[0]!
      .function.arguments;
    expect(args.length).toBeLessThan(TOOL_CALL_ARGS_CAP + 200);
    expect(args.startsWith("yyyy")).toBe(true);
  });

  test("ordinary arguments are left alone", () => {
    const before = session([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ]);
    expect(capToolResults(before).session).toBe(before);
  });

  test("everything else about the session is carried through", () => {
    const result = capToolResults(bigSession());
    expect(result.session.metadata?.github_context?.agent).toBe("engineer");
  });
});

describe("shrinking a restored session that will not fit", () => {
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
    expect(result.changed).toBe(0);
  });

  /**
   * The change this replaces #457 with. The old version dropped each result
   * together with the call that produced it, so an agent resuming lost the record
   * of what it had already looked at — and #544 measured what that costs: 169
   * distinct searches and no report. An agent that cannot see what it searched
   * searches again.
   */
  test("the calls survive; only what came back is gone", () => {
    const result = shrinkIfNeeded(bigSession());
    expect(result.shrunk).toBe(true);
    expect(result.tokensBefore).toBeGreaterThan(SESSION_TOKEN_LIMIT);
    expect(result.tokensAfter).toBeLessThan(SESSION_TOKEN_LIMIT);

    const before = bigSession();
    expect(callIds(result.session), "every call is still here").toEqual(callIds(before));
    expect(toolIds(result.session), "and so is every result message").toEqual(toolIds(before));

    const kept = result.session.messages ?? [];
    expect(kept[0]?.content, "the prompt prefix is untouched").toBe("You are engineer.");
    expect(kept.some((m) => m.content === "Reading file 0."), "and what the agent said").toBe(true);
  });

  /**
   * The structural rule, and the reason this operation removes nothing at all: a
   * `tool` message answers an assistant turn's `tool_calls`, and a provider
   * rejects either half without the other. A shrink that produced one would trade
   * "too big to run" for "malformed and will never run".
   */
  test("no message is removed, so no pair can be broken", () => {
    const before = bigSession();
    const after = replaceOldToolResults(before).session;
    expect((after.messages ?? []).length).toBe((before.messages ?? []).length + 1); // + the notice
  });

  test("the most recent results keep their contents", () => {
    const result = replaceOldToolResults(bigSession());
    const results = (result.session.messages ?? []).filter((m) => m.role === "tool");
    const recent = results.slice(-KEEP_RECENT_RESULTS);
    for (const m of recent) {
      expect(String(m.content), "a recent result is whole").not.toContain("was removed so the session");
    }
    expect(String(results[0]?.content), "an old one is not").toContain("was removed so the session");
  });

  /**
   * Replacing 40 characters with a 150-character notice would make the session
   * bigger, which is the opposite of the job.
   */
  test("a result already small enough is left alone", () => {
    const messages: SessionMessage[] = [];
    for (let n = 0; n < 30; n += 1) {
      messages.push({ role: "assistant", content: "", tool_calls: [{ id: `c${n}` }] });
      messages.push({ role: "tool", tool_call_id: `c${n}`, content: "ok" });
    }
    const result = replaceOldToolResults(session(messages));
    expect(result.shrunk).toBe(false);
  });

  /**
   * The sentence that matters is the second one: the calls are still there, so
   * the agent re-fetches what it still needs rather than everything.
   */
  test("the agent is told, in the role it reads as being told", () => {
    const kept = replaceOldToolResults(bigSession()).session.messages ?? [];
    const notice = kept[kept.length - 1];
    expect(notice?.role).toBe("user");
    expect(String(notice?.content)).toContain("calls themselves are still here");
    expect(String(notice?.content)).toContain("do not answer from memory");
    expect(notice?.atoma_metadata?.layer).toBe("session-shrink");
  });

  test("the notice counts what went", () => {
    expect(String(shrinkNotice(42).content)).toContain("42 earlier tool results");
  });

  /**
   * A long conversation with no tool traffic has nothing this can take, and must
   * not gain a notice saying it lost something.
   */
  test("a session with nothing to replace is left alone and says so", () => {
    const talk = session([
      { role: "system", content: "You are engineer." },
      { role: "user", content: "x".repeat(500_000) },
    ]);
    const result = shrinkIfNeeded(talk);
    expect(result.tokensBefore).toBeGreaterThan(SESSION_TOKEN_LIMIT);
    expect(result.shrunk, "there is nothing here that this strategy can touch").toBe(false);
    expect(result.session.messages).toHaveLength(2);
  });

  /**
   * The limit #539 exists to answer properly. Until it does, failing every run
   * with a provider error nobody connects to this is not acceptable, so the one
   * way out is named where somebody reading the run will see it.
   */
  test("a session that is still too big afterwards says what to do about it", () => {
    const talk = session([{ role: "user", content: "x".repeat(500_000) }]);
    const line = stillTooBigLine(shrinkIfNeeded(talk));
    expect(line, "over the limit with nothing left to replace").toBeDefined();
    expect(line).toContain("recover");
  });

  test("and an ordinary session says nothing", () => {
    expect(stillTooBigLine(shrinkIfNeeded(session([{ role: "user", content: "small" }])))).toBeUndefined();
  });

  test("everything else about the session is carried through", () => {
    expect(shrinkIfNeeded(bigSession()).session.metadata?.github_context?.agent).toBe("engineer");
  });
});

import { describe, expect, test } from "bun:test";
import { escapedMentionNotice, escapeUnknownMentions } from "./mention.ts";

const KNOWN = ["hws-yuma-seno", "Some-Reviewer"];

describe("checking who an agent tried to notify", () => {
  test("a participant is left alone", () => {
    const result = escapeUnknownMentions("@hws-yuma-seno please look at this", KNOWN);
    expect(result.text).toBe("@hws-yuma-seno please look at this");
    expect(result.escaped).toEqual([]);
  });

  /** GitHub logins are case-insensitive, so the check has to be. */
  test("case does not decide whether a person gets notified", () => {
    const result = escapeUnknownMentions("@SOME-reviewer take a look", KNOWN);
    expect(result.escaped).toEqual([]);
  });

  /**
   * The failure this exists for: a name read out of a commit log or a dependency's
   * README, repeated into a comment, notifying a stranger with nothing on this side
   * to show it happened.
   */
  test("a stranger is escaped, and still readable", () => {
    const result = escapeUnknownMentions("Based on @torvalds' advice", KNOWN);
    expect(result.text).toBe("Based on `@torvalds`' advice");
    expect(result.escaped).toEqual(["torvalds"]);
  });

  test("several strangers are reported once each", () => {
    const result = escapeUnknownMentions("@a and @b and @a again", KNOWN);
    expect(result.escaped).toEqual(["a", "b"]);
    expect(result.text).toBe("`@a` and `@b` and `@a` again");
  });

  /**
   * Escaping inside a code block would change code somebody is meant to read, and
   * GitHub does not notify from there anyway -- so the safe-looking thing is the
   * destructive one.
   */
  test("a fenced code block is left exactly as written", () => {
    const text = ["Here is the log:", "```", "commit by @torvalds", "```", "and @stranger outside"].join("\n");
    const result = escapeUnknownMentions(text, KNOWN);
    expect(result.text).toContain("commit by @torvalds");
    expect(result.text).toContain("`@stranger` outside");
    expect(result.escaped).toEqual(["stranger"]);
  });

  test("an inline code span is left alone too", () => {
    const result = escapeUnknownMentions("run `npm i @scope/pkg` then ask @stranger", KNOWN);
    expect(result.text).toContain("`npm i @scope/pkg`");
    expect(result.text).toContain("`@stranger`");
  });

  test("an already escaped mention is not escaped twice", () => {
    const result = escapeUnknownMentions("see `@stranger` above", KNOWN);
    expect(result.text).toBe("see `@stranger` above");
    expect(result.escaped).toEqual([]);
  });

  /** An email address is not a mention, and neither is a scoped package. */
  test("what looks like a mention and is not", () => {
    const text = "mail me at yuma@example.com, install @types/node, see docs@v2";
    const result = escapeUnknownMentions(text, KNOWN);
    expect(result.text).toBe(text);
    expect(result.escaped).toEqual([]);
  });

  /**
   * Fail closed. Not being pinged when you should have been is a comment you can
   * still read; being pinged by a machine you have nothing to do with is not
   * something anyone here would find out about.
   */
  test("with no known participants, everything is escaped", () => {
    const result = escapeUnknownMentions("@hws-yuma-seno look", []);
    expect(result.text).toBe("`@hws-yuma-seno` look");
    expect(result.escaped).toEqual(["hws-yuma-seno"]);
  });

  test("text with no mentions is returned unchanged", () => {
    const text = "Nothing to see here.\n\n```\ncode\n```\n";
    expect(escapeUnknownMentions(text, KNOWN).text).toBe(text);
  });

  test("a mention at the very start is still caught", () => {
    const result = escapeUnknownMentions("@stranger hello", KNOWN);
    expect(result.text).toBe("`@stranger` hello");
  });
});

describe("what the thread is told", () => {
  test("nothing escaped, nothing said", () => {
    expect(escapedMentionNotice([])).toBeUndefined();
  });

  test("the notice names them and says nobody was notified", () => {
    const notice = escapedMentionNotice(["torvalds"]) ?? "";
    expect(notice).toContain("`@torvalds`");
    expect(notice).toContain("Nobody was notified");
    // "could not confirm" rather than "is not": the list is sometimes unreadable,
    // and a notice that overstates what was checked is a notice a person then has
    // to go and check.
    expect(notice).toContain("could not confirm");
    expect(notice, "singular reads as English").toContain("was written as a mention");
  });

  test("and reads as English in the plural", () => {
    const notice = escapedMentionNotice(["a", "b"]) ?? "";
    expect(notice).toContain("were written as mentions");
    expect(notice).toContain("those accounts");
  });
});

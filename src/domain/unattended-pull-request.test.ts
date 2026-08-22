import { describe, expect, test } from "bun:test";
import { isAttended, mentionsSomeone, unattendedNotice } from "./unattended-pull-request.ts";

describe("whether anybody was asked to look at a new pull request", () => {
  test("a named reviewer is enough", () => {
    expect(isAttended({ reviewer: "reviewer", body: "" })).toBe(true);
    expect(isAttended({ reviewer: "senior-reviewer", body: "no mentions here" })).toBe(true);
  });

  test("a mention is enough", () => {
    expect(isAttended({ reviewer: "", body: "@octocat could you look at this" })).toBe(true);
  });

  /**
   * The case this module exists for. #486 made asking explicit, which made
   * forgetting possible -- and forgetting is silent: CI runs, the check goes green,
   * and the work waits for somebody who was never told.
   */
  test("neither is unattended", () => {
    expect(isAttended({ reviewer: "", body: "Implements the thing." })).toBe(false);
    expect(isAttended({ reviewer: "   ", body: "" }), "whitespace is not a name").toBe(false);
  });
});

describe("finding a mention", () => {
  test("a plain mention counts", () => {
    expect(mentionsSomeone("cc @octocat")).toBe(true);
    expect(mentionsSomeone("@octocat")).toBe(true);
    expect(mentionsSomeone("(@octocat)")).toBe(true);
  });

  test("a hyphenated login counts", () => {
    expect(mentionsSomeone("@hws-yuma-seno please review")).toBe(true);
  });

  /**
   * An email address is not a mention. Neither is a path, and neither is an `@` in
   * the middle of a token -- a package spec like `@huggingface/transformers@4.2.0`
   * appears in this repository's own pull request bodies.
   */
  test("an address or a package spec is not a mention", () => {
    expect(mentionsSomeone("write to someone@example.com")).toBe(false);
    expect(mentionsSomeone("bun add @huggingface/transformers"), "scoped package").toBe(false);
    expect(mentionsSomeone("pinned at transformers@4.2.0")).toBe(false);
  });

  test("a bare at-sign is not a mention", () => {
    expect(mentionsSomeone("costs @ 3 per unit")).toBe(false);
    expect(mentionsSomeone("@")).toBe(false);
    expect(mentionsSomeone("@-leading-hyphen")).toBe(false);
  });

  test("nothing in an empty body", () => {
    expect(mentionsSomeone("")).toBe(false);
  });
});

describe("the notice", () => {
  test("mentions the person the run resolved to", () => {
    const notice = unattendedNotice("hws-yuma-seno", "engineer");
    expect(notice).toContain("@hws-yuma-seno");
    expect(notice).toContain("`engineer`");
    expect(notice, "and says what to do").toContain("/reviewer");
  });

  /**
   * `resolveNotify` returns "" when it can read no tag, no human author and no
   * parent. The comment is still posted: a pull request nobody is coming for is not
   * improved by also saying nothing about it.
   */
  test("still says it when there is nobody to name", () => {
    const notice = unattendedNotice("", "engineer");
    expect(notice.startsWith("@"), "no dangling at-sign").toBe(false);
    expect(notice).toContain("no reviewer named");
    expect(notice).toContain("/reviewer");
  });

  test("says CI is unaffected, so nobody reads this as a failure", () => {
    expect(unattendedNotice("x", "engineer")).toMatch(/CI still runs/);
  });
});

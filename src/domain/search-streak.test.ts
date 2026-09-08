import { describe, expect, test } from "bun:test";
import {
  classifyShellAct,
  MAX_SEARCHES_WITHOUT_OPENING,
  nextStreak,
  refusalReason,
} from "./search-streak.ts";

describe("what a shell command is doing", () => {
  test("the searches", () => {
    for (const command of [
      "grep -rn 'foo' src/",
      "rg --type ts handler",
      "find . -name '*.wac.ts'",
      "egrep -l pattern src",
      "/usr/bin/grep x file",
    ]) {
      expect(classifyShellAct(command), command).toBe("search");
    }
  });

  test("the opens", () => {
    for (const command of [
      "cat src/foo.ts",
      "head -50 src/foo.ts",
      "tail -n 100 log.txt",
      "sed -n '10,40p' src/foo.ts",
    ]) {
      expect(classifyShellAct(command), command).toBe("open");
    }
  });

  test("everything else is neither", () => {
    for (const command of ["bun test", "ls src", "git status", "cargo build", ""]) {
      expect(classifyShellAct(command), command).toBe("other");
    }
  });

  /**
   * The distinction that matters for the classification: `head` after a pipe paginates
   * a search, it does not open a file. Reading the first command of the pipeline is
   * what tells them apart.
   */
  test("pagination after a search is still a search", () => {
    expect(classifyShellAct("grep -rn foo src/ | head -20")).toBe("search");
    expect(classifyShellAct("rg pattern | wc -l")).toBe("search");
  });

  test("a prefix is stepped over, not read as the command", () => {
    expect(classifyShellAct("GREP_COLORS=never grep -rn foo src/")).toBe("search");
    expect(classifyShellAct("time rg pattern")).toBe("search");
  });
});

describe("the streak", () => {
  test("searching climbs it and opening clears it", () => {
    let streak = 0;
    for (const act of ["search", "search", "search"] as const) streak = nextStreak(streak, act);
    expect(streak).toBe(3);
    expect(nextStreak(streak, "open")).toBe(0);
  });

  /**
   * Running the tests between searches is work, but it is not using what the searches
   * found. An agent that searches ten times, runs the tests, then searches ten more
   * has still opened nothing.
   */
  test("other work neither climbs it nor clears it", () => {
    expect(nextStreak(7, "other")).toBe(7);
  });
});

describe("the refusal", () => {
  test("nothing is refused below the limit", () => {
    expect(refusalReason(MAX_SEARCHES_WITHOUT_OPENING - 1)).toBeUndefined();
    expect(refusalReason(0)).toBeUndefined();
  });

  /**
   * The measured p95 is 3 and the p99 is 8, so an ordinary run never comes near this.
   * The three sessions that did reached 30, 44 and 85.
   */
  test("an ordinary run is never refused", () => {
    for (const streak of [0, 1, 3, 8]) {
      expect(refusalReason(streak), `p95 is 3, p99 is 8; ${streak} is ordinary`).toBeUndefined();
    }
  });

  test("at the limit it says what a search is for and what to do instead", () => {
    const reason = refusalReason(MAX_SEARCHES_WITHOUT_OPENING);
    expect(reason).toBeDefined();
    expect(reason).toContain("where something is, not what it is");
    expect(reason).toContain("open the most promising result");
  });

  /**
   * A refusal has to leave somewhere to go. Fifteen searches with nothing opened is
   * usually an agent guessing at what a thing is called, and guessing is exactly what
   * `search_code` answers — measured, 80% in the top five against 42% for the keywords
   * from the same question.
   */
  test("it points at the tool for the case that caused it", () => {
    const reason = refusalReason(MAX_SEARCHES_WITHOUT_OPENING);
    expect(reason).toContain("search__search_code");
    expect(reason).toContain("in a sentence");
  });

  test("the count in the message is the real one", () => {
    expect(refusalReason(85)).toContain("85 searches");
  });
});

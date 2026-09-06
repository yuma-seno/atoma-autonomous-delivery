import { describe, expect, test } from "bun:test";
import { failureNotice, logExcerpt } from "./report_run_failure.ts";
import { LLM_CONTEXT_TAG } from "../lib/tags.ts";

describe("report_run_failure.ts", () => {
  /**
   * The new fact, and the one somebody who has used Atoma before will assume the
   * opposite of. If this line goes, a person reads a failure as lost work and
   * re-does it.
   */
  test("says the session survived, and how to use it either way", () => {
    const body = failureNotice("engineer", "octocat", "http://example.com/run/1", "");
    expect(body).toContain("The session was saved");
    expect(body).toContain("`/engineer`");
    expect(body).toContain("`/engineer recover`");
  });

  test("mentions whoever is watching, when there is one", () => {
    expect(failureNotice("engineer", "octocat", "u", "")).toContain("@octocat");
    expect(failureNotice("engineer", undefined, "u", "")).not.toContain("@");
  });

  // Addressed to a person and useless to the next run, which would only carry it.
  test("is kept out of the agent's context", () => {
    expect(failureNotice("engineer", "octocat", "u", "")).toContain(LLM_CONTEXT_TAG.write("exclude"));
  });

  test("carries the run's own link", () => {
    expect(failureNotice("engineer", undefined, "http://example.com/run/7", "")).toContain(
      "http://example.com/run/7",
    );
  });

  /**
   * Below the part that always matters, because it usually is not: "MCP server
   * closed connection" is not something a person can act on.
   */
  test("an excerpt goes after the instructions, and a missing one changes nothing", () => {
    const withExcerpt = failureNotice("engineer", undefined, "u", "error: boom");
    expect(withExcerpt.indexOf("error: boom")).toBeGreaterThan(withExcerpt.indexOf("Start clean"));
    expect(failureNotice("engineer", undefined, "u", "")).not.toContain("```");
  });
});

describe("the excerpt", () => {
  test("keeps only the lines that might say what went wrong", () => {
    const log = ["starting up", "ERROR: could not connect", "reading file", "panic: nope"].join("\n");
    const excerpt = logExcerpt(log);
    expect(excerpt).toContain("ERROR: could not connect");
    expect(excerpt).toContain("panic: nope");
    expect(excerpt).not.toContain("reading file");
  });

  test("stops at five, because a comment is not a log viewer", () => {
    const log = Array.from({ length: 20 }, (_, i) => `error ${i}`).join("\n");
    expect(logExcerpt(log).split("\n")).toHaveLength(5);
  });

  /**
   * `unauthorized` is one of the words this greps for, and is exactly the line a
   * provider emits with the credential in it. Actions masks secrets in the
   * workflow log and does nothing for an issue comment.
   */
  test("credential-shaped text does not survive into the comment", () => {
    const excerpt = logExcerpt("unauthorized: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(excerpt).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  test("a log with nothing interesting yields nothing", () => {
    expect(logExcerpt("all fine\nstill fine")).toBe("");
  });
});

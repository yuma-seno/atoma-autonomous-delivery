import { describe, expect, test } from "bun:test";
import { stopRequestedNotice } from "./request_stop.ts";
import { LLM_CONTEXT_TAG, STOP_TAG } from "../lib/tags.ts";

describe("request_stop.ts", () => {
  // The notice IS the request: the running job polls for this tag. A notice that
  // reads well and carries no tag would tell the person a stop is coming and stop
  // nothing.
  test("carries the tag the running job polls for", () => {
    expect(STOP_TAG.has(stopRequestedNotice("octocat", true, []))).toBe(true);
  });

  // A stop must not become the next run's context, and neither must the notice
  // about it.
  test("is excluded from the agent's context", () => {
    expect(stopRequestedNotice("octocat", true, [])).toContain(LLM_CONTEXT_TAG.write("exclude"));
  });

  test("mentions whoever asked", () => {
    expect(stopRequestedNotice("octocat", true, [])).toContain("@octocat");
    expect(stopRequestedNotice("", true, [])).not.toContain("@");
  });

  // The existing in-progress guard also deletes comments. Someone whose `/stop`
  // vanished with no explanation could not tell which of the two happened.
  test("says what became of the comment, either way", () => {
    expect(stopRequestedNotice("octocat", true, [])).toContain("was removed");
    expect(stopRequestedNotice("octocat", false, [])).toContain("could not be removed");
  });

  // The lag is what people will misread: a stop is picked up on the next poll and
  // taken at the next turn, so the agent can finish a tool call and start another.
  test("says the stop is not immediate, and that nothing is lost", () => {
    const notice = stopRequestedNotice("octocat", true, []);
    expect(notice).toContain("current step");
    expect(notice).toContain("session is saved");
  });

  // A parent keeps the in-progress label while its chain runs on a sub-issue, so a
  // `/stop` aimed at the parent can be aimed at the wrong number without anyone
  // doing anything wrong.
  test("names the sub-issues a stop here does not reach", () => {
    const notice = stopRequestedNotice("octocat", true, [12, 13]);
    expect(notice).toContain("#12, #13");
    expect(notice).toContain("does not reach");
  });

  test("says nothing about children when there are none", () => {
    expect(stopRequestedNotice("octocat", true, [])).not.toContain("does not reach");
  });
});

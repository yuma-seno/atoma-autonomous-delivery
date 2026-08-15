import { describe, expect, test } from "bun:test";
import { shouldMentionOnCompletion, type CompletionSignals } from "./completion-mention.ts";

const base: CompletionSignals = {
  chainContinues: false,
  notify: "someone",
  isSubIssue: false,
  issueClosed: false,
};

describe("shouldMentionOnCompletion", () => {
  test("mentions when a run ends with nothing following it", () => {
    expect(shouldMentionOnCompletion(base)).toBe(true);
  });

  test("says nothing when there is nobody to mention", () => {
    expect(shouldMentionOnCompletion({ ...base, notify: "" })).toBe(false);
  });

  test("says nothing when the agent handed off to another agent", () => {
    expect(shouldMentionOnCompletion({ ...base, directive: "reviewer" })).toBe(false);
  });

  test("says nothing when a tool call already dispatched the next run", () => {
    expect(shouldMentionOnCompletion({ ...base, chainContinues: true })).toBe(false);
  });

  // The case this module exists for: closing a sub-issue is what wakes its
  // parent, and that dispatch happens in a later workflow run, so the run that
  // closed it sees no chain of its own.
  test("says nothing when a closed sub-issue hands back to its parent", () => {
    expect(shouldMentionOnCompletion({ ...base, isSubIssue: true, issueClosed: true })).toBe(false);
  });

  // Nothing wakes a parent for an unfinished sub-task, so this really has
  // stopped -- the one sub-issue case a person must hear about.
  test("still mentions when a sub-issue run ends with the sub-issue open", () => {
    expect(shouldMentionOnCompletion({ ...base, isSubIssue: true, issueClosed: false })).toBe(true);
  });

  // A root issue is nobody's sub-task; closing it ends the work rather than
  // handing it on.
  test("still mentions when a closed issue has no parent", () => {
    expect(shouldMentionOnCompletion({ ...base, issueClosed: true })).toBe(true);
  });
});

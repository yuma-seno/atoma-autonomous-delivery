import { describe, expect, test } from "bun:test";
import { decidePostMergeHandoff } from "./handoff.ts";

describe("decidePostMergeHandoff", () => {
  test("no-parent when the PR has no linked parent issue", () => {
    expect(
      decidePostMergeHandoff({ parentIssue: undefined, parentAlreadyClosed: false, originAgent: undefined }),
    ).toEqual({ kind: "no-parent" });
  });

  test("already-closed when the parent is already closed, even if an origin agent is tagged", () => {
    expect(
      decidePostMergeHandoff({ parentIssue: 5, parentAlreadyClosed: true, originAgent: "engineer" }),
    ).toEqual({ kind: "already-closed", parentIssue: 5 });
  });

  test("reinvoke-origin-agent when an origin agent is tagged and the parent is still open", () => {
    expect(
      decidePostMergeHandoff({ parentIssue: 5, parentAlreadyClosed: false, originAgent: "engineer" }),
    ).toEqual({ kind: "reinvoke-origin-agent", parentIssue: 5, agent: "engineer" });
  });

  test("close-directly when there is no origin agent tag", () => {
    expect(
      decidePostMergeHandoff({ parentIssue: 5, parentAlreadyClosed: false, originAgent: undefined }),
    ).toEqual({ kind: "close-directly", parentIssue: 5 });
  });

  test("already-closed takes priority over no origin agent too", () => {
    expect(
      decidePostMergeHandoff({ parentIssue: 5, parentAlreadyClosed: true, originAgent: undefined }),
    ).toEqual({ kind: "already-closed", parentIssue: 5 });
  });
});

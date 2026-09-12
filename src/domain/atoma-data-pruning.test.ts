import { describe, expect, test } from "bun:test";
import { issueNumberOf, prunablePaths, pruneCommitMessage } from "./atoma-data-pruning.ts";

describe("issueNumberOf", () => {
  test("reads a workspace path, in the layout the branch holds", () => {
    expect(issueNumberOf("workspace/issue-492/probe/check.sh")).toBe(492);
    expect(issueNumberOf("workspace/issue-7")).toBe(7);
  });

  /**
   * The property that matters most here, and the one that was briefly untrue. Sessions
   * are kept permanently: they are the only measurement substrate this project has, and
   * they are cheap -- every version of every session is 40 MB of text and 4.7 MB packed,
   * because appended-to JSON compresses. See the module comment.
   */
  test("never reads an issue out of a session path", () => {
    expect(issueNumberOf("sessions/issue-10-engineer.json")).toBeUndefined();
    expect(issueNumberOf("sessions/issue-7/engineer.json")).toBeUndefined();
    expect(issueNumberOf("sessions/issue-182/archive/orchestrator-1.json")).toBeUndefined();
  });

  /**
   * Anything unrecognised is left alone, because the alternative to a guess here is a
   * deletion. The index is the case that matters: it lived under `search/` on this
   * branch, is owned by no issue, and is named `issue-index.json`.
   */
  test("anything it cannot read belongs to no issue", () => {
    expect(issueNumberOf("search/issue-index.json")).toBeUndefined();
    expect(issueNumberOf("sessions/scratch.json")).toBeUndefined();
    expect(issueNumberOf("sessions/issue-abc.json")).toBeUndefined();
    expect(issueNumberOf("sessions/issue-0-engineer.json")).toBeUndefined();
    expect(issueNumberOf("README.md")).toBeUndefined();
  });
});

describe("prunablePaths", () => {
  const paths = [
    "sessions/issue-1-engineer.json",
    "sessions/issue-2/engineer.json",
    "workspace/issue-1/notes.md",
    "workspace/issue-2/probe/x.sh",
    "search/issue-index.json",
  ];

  test("takes the workspace of an issue that is over, and nothing else", () => {
    const decision = prunablePaths(paths, (issue) => issue === 2);
    expect(decision.paths).toEqual(["workspace/issue-2/probe/x.sh"]);
    expect(decision.issues).toEqual([2]);
  });

  test("a closed issue keeps its session", () => {
    expect(prunablePaths(paths, () => true).paths).toEqual([
      "workspace/issue-1/notes.md",
      "workspace/issue-2/probe/x.sh",
    ]);
  });

  /** One issue, one question. A busy issue has several files and one answer. */
  test("asks once per issue rather than once per path", () => {
    let asked = 0;
    prunablePaths(paths, (issue) => {
      asked += 1;
      return issue === 2;
    });
    expect(asked).toBe(2);
  });

  test("nothing is over, nothing is taken", () => {
    expect(prunablePaths(paths, () => false).paths).toEqual([]);
  });

  /**
   * The index is regenerable and owned by nobody, which is exactly the shape of a file
   * a rule about issues could delete by accident. It cannot be reached from here at all.
   */
  test("a file belonging to no issue is never taken, even when everything is over", () => {
    const decision = prunablePaths(paths, () => true);
    expect(decision.paths).not.toContain("search/issue-index.json");
  });
});

describe("pruneCommitMessage", () => {
  test("names the issues, so a missing session can be traced to a commit", () => {
    expect(pruneCommitMessage({ paths: ["a", "b", "c"], issues: [2, 9] })).toBe(
      "atoma: prune 3 files from closed issues",
    );
  });

  test("one file reads as one", () => {
    expect(pruneCommitMessage({ paths: ["a"], issues: [9] })).toBe(
      "atoma: prune 1 file from closed issues",
    );
  });
});

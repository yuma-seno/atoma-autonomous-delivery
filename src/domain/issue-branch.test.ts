import { describe, expect, test } from "bun:test";
import { branchToResume, nextBranchName, type IssueBranch } from "./issue-branch.ts";

const b = (name: string, merged = false): IssueBranch => ({ name, merged });

describe("branchToResume", () => {
  test("nothing to resume when the issue has no branch", () => {
    expect(branchToResume([], 12)).toBe("");
  });

  test("resumes an unmerged branch", () => {
    expect(branchToResume([b("atoma/issue-12")], 12)).toBe("atoma/issue-12");
  });

  // The case that stops a completion check from creating a branch: everything
  // this issue owned has landed, so there is nothing to continue.
  test("stays on the base once every branch has merged", () => {
    expect(branchToResume([b("atoma/issue-12", true)], 12)).toBe("");
  });

  test("resumes the newest unmerged branch when work continued after a merge", () => {
    const branches = [b("atoma/issue-12", true), b("atoma/issue-12-2")];
    expect(branchToResume(branches, 12)).toBe("atoma/issue-12-2");
  });

  // Numeric ordering, not lexicographic: `-10` is newer than `-9`.
  test("orders suffixes numerically", () => {
    const branches = [b("atoma/issue-12-9", true), b("atoma/issue-12-10")];
    expect(branchToResume(branches, 12)).toBe("atoma/issue-12-10");
  });

  // `atoma/issue-1` must not claim `atoma/issue-12`'s branches.
  test("does not match an issue whose number is a prefix of another", () => {
    expect(branchToResume([b("atoma/issue-120")], 12)).toBe("");
    expect(branchToResume([b("atoma/issue-12-x")], 12)).toBe("");
  });

  // The case the comment above describes and the assertions above missed: it is
  // the *suffixed* branch of the longer number that got claimed. For issue 1 the
  // remainder of `atoma/issue-12-3` is `2-3`, and an unanchored search for a
  // trailing `-<digits>` finds one — so issue 1 resumed issue 12's work, committed
  // to it, and opened a pull request from it.
  test("does not claim the suffixed branch of an issue whose number is longer", () => {
    expect(branchToResume([b("atoma/issue-12-3")], 1)).toBe("");
    expect(branchToResume([b("atoma/issue-120-7")], 12)).toBe("");
  });

  test("ignores branches belonging to no issue", () => {
    expect(branchToResume([b("main"), b("feature/thing")], 12)).toBe("");
  });
});

describe("nextBranchName", () => {
  test("the first branch carries no suffix", () => {
    expect(nextBranchName([], 12)).toBe("atoma/issue-12");
  });

  test("counts up once the plain name is taken", () => {
    expect(nextBranchName([b("atoma/issue-12", true)], 12)).toBe("atoma/issue-12-2");
  });

  // From the highest taken, not from how many exist, so deleting an old branch
  // cannot hand out a name that was already used.
  test("counts from the highest suffix rather than the count", () => {
    const branches = [b("atoma/issue-12", true), b("atoma/issue-12-5", true)];
    expect(nextBranchName(branches, 12)).toBe("atoma/issue-12-6");
  });

  test("is unaffected by other issues' branches", () => {
    const branches = [b("atoma/issue-120", true), b("atoma/issue-3-7", true)];
    expect(nextBranchName(branches, 12)).toBe("atoma/issue-12");
  });
});

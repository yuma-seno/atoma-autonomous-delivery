import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommentBody } from "./post_result_comment.ts";
import type { Session } from "../lib/session.ts";
import { runWithFakeGh, scriptPath } from "./testing/harness.ts";

describe("post_result_comment.ts buildCommentBody", () => {
  test("mentions notify when there is no directive and the chain does not continue", () => {
    const body = buildCommentBody({
      agent: "orchestrator",
      notify: "octocat",
      runUrl: "http://example.com/run/1",
      output: "All done.",
      usageLines: [],
    });
    expect(body).toContain("<!-- atoma:agent=orchestrator -->");
    expect(body).toContain("All done.");
    expect(body).toContain("@octocat");
    expect(body).toContain("_run by [orchestrator](http://example.com/run/1)_");
  });

  test("omits the mention when a directive is present", () => {
    const body = buildCommentBody({
      agent: "orchestrator",
      notify: "octocat",
      directive: "engineer",
      runUrl: "http://example.com/run/1",
      output: "Handing off.",
      usageLines: [],
    });
    expect(body).not.toContain("@octocat");
  });

  test("omits the mention when the chain already continues", () => {
    const body = buildCommentBody({
      agent: "orchestrator",
      notify: "octocat",
      chainContinues: "true",
      runUrl: "http://example.com/run/1",
      output: "Dispatched.",
      usageLines: [],
    });
    expect(body).not.toContain("@octocat");
  });

  // Closing a sub-issue is what wakes its parent, in a later workflow run that
  // this one cannot see -- so `chainContinues` is false here and the mention
  // would otherwise ask a person to act on work that is still moving.
  test("omits the mention when a closed sub-issue hands back to its parent", () => {
    const body = buildCommentBody({
      agent: "engineer",
      notify: "octocat",
      isSubIssue: true,
      issueClosed: true,
      runUrl: "http://example.com/run/1",
      output: "Merged in PR #173. Closing this sub-task.",
      usageLines: [],
    });
    expect(body).not.toContain("@octocat");
  });

  test("keeps the mention when a sub-issue run ends with the sub-issue open", () => {
    const body = buildCommentBody({
      agent: "engineer",
      notify: "octocat",
      isSubIssue: true,
      issueClosed: false,
      runUrl: "http://example.com/run/1",
      output: "I could not finish this.",
      usageLines: [],
    });
    expect(body).toContain("@octocat");
  });

  test("appends the max-iterations warning", () => {
    const body = buildCommentBody({
      agent: "engineer",
      maxIterationsReached: "true",
      runUrl: "http://example.com/run/1",
      output: "Still working.",
      usageLines: [],
    });
    expect(body).toContain("Max iterations reached");
    expect(body).toContain("`/engineer`");
  });
});

describe("post_result_comment.ts main", () => {
  /**
   * The path is required, and this is why.
   *
   * It used to open `atoma_output.txt` relative to the working directory. #487
   * moved the run's files out of the work tree and the read went to a path that no
   * longer existed -- landing in the "empty output" branch, whose message reads
   * like a session that ended via a tool call. Two releases shipped where no
   * agent's report reached anyone, with every step reporting success.
   *
   * A default would put that back for any caller that forgot the argument. Exiting
   * non-zero instead makes a missing argument a failed step, which is the one thing
   * the original could not be.
   */
  test("refuses to run without --output rather than guessing a path", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-post-result-"));
    try {
      // A file the old relative read would have found and posted from.
      writeFileSync(join(dir, "atoma_output.txt"), "All done.");
      const r = runWithFakeGh(
        scriptPath("post_result_comment.ts"),
        ["--number", "5", "--agent", "engineer", "--run-url", "http://example.com/run/1"],
        { cwd: dir, rules: [{ match: ["api", "comments"] }] },
      );
      expect(r.status, "a missing --output is a failed step, not a silent skip").not.toBe(0);
      expect(r.ghCalls.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips posting entirely when the output file is missing (session ended via a tool call)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-post-result-"));
    try {
      const r = runWithFakeGh(
        scriptPath("post_result_comment.ts"),
        ["--number", "5", "--agent", "orchestrator", "--notify", "octocat", "--run-url", "http://example.com/run/1", "--output", join(dir, "atoma_output.txt")],
        { cwd: dir, rules: [{ match: ["api", "comments"] }] },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips posting entirely when atoma_output.txt is blank", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-post-result-"));
    writeFileSync(join(dir, "atoma_output.txt"), "   \n");
    try {
      const r = runWithFakeGh(
        scriptPath("post_result_comment.ts"),
        ["--number", "5", "--agent", "orchestrator", "--run-url", "http://example.com/run/1", "--output", join(dir, "atoma_output.txt")],
        { cwd: dir, rules: [{ match: ["api", "comments"] }] },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("posts normally when atoma_output.txt has real content", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-post-result-"));
    writeFileSync(join(dir, "atoma_output.txt"), "All done.");
    try {
      const r = runWithFakeGh(
        scriptPath("post_result_comment.ts"),
        ["--number", "5", "--agent", "orchestrator", "--run-url", "http://example.com/run/1", "--output", join(dir, "atoma_output.txt")],
        { cwd: dir, env: { GITHUB_REPOSITORY: "owner/repo" }, rules: [{ match: ["api", "comments"], stdout: "42" }] },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.join(" ").includes("comments"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads the issue's own state to decide the mention, and only for an issue run", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-post-result-"));
    writeFileSync(join(dir, "atoma_output.txt"), "Merged and closed.");
    try {
      const r = runWithFakeGh(
        scriptPath("post_result_comment.ts"),
        // prettier-ignore
        ["--number", "5", "--type", "issue", "--agent", "engineer", "--notify", "octocat", "--run-url", "http://example.com/run/1", "--output", join(dir, "atoma_output.txt")],
        {
          cwd: dir,
          env: { GITHUB_REPOSITORY: "owner/repo" },
          rules: [
            { match: ["issue", "view", "5"], stdout: JSON.stringify({ state: "CLOSED", body: "<!-- atoma:parent=4 -->" }) },
            { match: ["api", "comments"], stdout: "42" },
          ],
        },
      );
      expect(r.status).toBe(0);
      const posted = r.ghCalls.find((c) => c.join(" ").includes("comments"))?.join(" ") ?? "";
      expect(posted).not.toContain("@octocat");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A pull request run's `--number` is a PR number, and `gh issue view` on one
  // is an error rather than an answer.
  test("does not look the number up as an issue on a pull request run", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-post-result-"));
    writeFileSync(join(dir, "atoma_output.txt"), "Reviewed.");
    try {
      const r = runWithFakeGh(
        scriptPath("post_result_comment.ts"),
        ["--number", "7", "--type", "pr", "--agent", "reviewer", "--run-url", "http://example.com/run/1", "--output", join(dir, "atoma_output.txt")],
        { cwd: dir, env: { GITHUB_REPOSITORY: "owner/repo" }, rules: [{ match: ["api", "comments"], stdout: "42" }] },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("view"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

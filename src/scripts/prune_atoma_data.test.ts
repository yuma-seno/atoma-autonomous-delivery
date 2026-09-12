import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithFakeGh, scriptPath, type FakeGhRule } from "./testing/harness.ts";

/**
 * The script end to end: a real `atoma-data` to read, a fake `gh` to answer about the
 * issues, and `--dry-run` so nothing is pushed.
 *
 * A unit test of `domain/atoma-data-pruning.ts` checks the decision and can never see
 * what this does — whether the file asks GitHub the right question at all. It exists
 * because it did not. `ghPaginated` takes the argv of a `gh` call and the first word has
 * to be `api`; the first version omitted it and every run died with
 * `unknown command "repos/…"`. Typecheck cannot see a wrong string in a variadic
 * `...string[]`, and the failure only appeared when an issue was closed in production.
 *
 * The repository is built here rather than borrowed from the checkout, because a test
 * that reads the real `atoma-data` would depend on what that branch happens to hold and
 * on the network being there.
 */
const ISSUES = JSON.stringify([
  { number: 1, state: "open", labels: [] },
  { number: 2, state: "closed", labels: [] },
  { number: 3, state: "closed", labels: [{ name: "atoma/in-progress" }] },
]);

let repo: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

beforeAll(() => {
  // One directory serving as both the checkout and its own `origin`, which is all the
  // script needs: it fetches `origin/atoma-data` and lists it.
  repo = mkdtempSync(join(tmpdir(), "atoma-prune-test-"));
  git(repo, "init", "--quiet", "--initial-branch=atoma-data");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  for (const path of [
    "sessions/issue-2/engineer.json",
    "workspace/issue-1/notes.md",
    "workspace/issue-2/probe/check.sh",
    "workspace/issue-3/scratch.txt",
    "search/issue-index.json",
  ]) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), "{}");
  }
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", "seed");
  git(repo, "remote", "add", "origin", repo);
  git(repo, "fetch", "--quiet", "origin", "atoma-data");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function run(rules: FakeGhRule[]) {
  return runWithFakeGh(scriptPath("prune_atoma_data.ts"), ["--repo", "acme/widgets", "--dry-run"], {
    rules,
    cwd: repo,
    // git work happens in the temp repository above; `config.json` is read from the
    // real checkout, which is what `ATOMA_MACHINERY_ROOT` exists to separate. Without
    // it the label lookup reads the temp directory and throws on a file that is not
    // there -- the script's own resolution, exercised rather than stubbed.
    env: { ATOMA_MACHINERY_ROOT: process.cwd() },
  });
}

describe("prune_atoma_data.ts", () => {
  test("asks the issues API the way gh expects to be asked", () => {
    const asked = run([{ match: ["api", "issues"], stdout: ISSUES }]).ghCalls.filter((argv) =>
      argv.some((part) => part.includes("issues")),
    );
    expect(asked.length, "it should read the issues at all").toBeGreaterThan(0);
    for (const argv of asked) {
      // The bug this test exists for: without `api`, gh reads the path as a subcommand.
      expect(argv[0]).toBe("api");
      expect(argv).toContain("--paginate");
    }
  });

  test("reads both open and closed, since one call returns neither", () => {
    const queried = run([{ match: ["api", "issues"], stdout: ISSUES }])
      .ghCalls.map((argv) => argv.join(" "))
      .join("\n");
    expect(queried).toContain("state=open");
    expect(queried).toContain("state=closed");
  });

  test("takes the closed issue, leaves the open one and the one still running", () => {
    const printed = run([{ match: ["api", "issues"], stdout: ISSUES }]).stderr;
    expect(printed).toContain("workspace/issue-2/probe/check.sh");
    expect(printed).not.toContain("workspace/issue-1/notes.md");
    expect(printed).not.toContain("workspace/issue-3/scratch.txt");
  });

  /**
   * End to end, because this is the property that was briefly untrue in production:
   * 102 sessions were deleted before being restored the same day. They are the only
   * measurement substrate this project has, and they compress to 4.7 MB.
   */
  test("never takes a session, whatever its issue says", () => {
    const printed = run([{ match: ["api", "issues"], stdout: ISSUES }]).stderr;
    expect(printed).not.toContain("sessions/");
  });

  /** Regenerable, owned by nobody, and named `issue-index.json`. */
  test("never reaches the search index", () => {
    expect(run([{ match: ["api", "issues"], stdout: ISSUES }]).stderr).not.toContain("search/");
  });

  /**
   * A dry run is a dry run. If this ever pushed, it would do so against a branch whose
   * sessions live jobs are writing.
   */
  test("--dry-run pushes nothing", () => {
    const before = execFileSync("git", ["rev-parse", "atoma-data"], { cwd: repo, encoding: "utf8" });
    run([{ match: ["api", "issues"], stdout: ISSUES }]);
    const after = execFileSync("git", ["rev-parse", "atoma-data"], { cwd: repo, encoding: "utf8" });
    expect(after).toBe(before);
  });
});

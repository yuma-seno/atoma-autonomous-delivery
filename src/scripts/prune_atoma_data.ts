#!/usr/bin/env bun
/**
 * prune_atoma_data.ts — remove what `atoma-data` is storing for work that is over.
 *
 * See `domain/atoma-data-pruning.ts` for why the rule is the issue's state rather than
 * an age, and what is deliberately left alone. This file is the part that talks to
 * GitHub and to git.
 *
 * Runs when an issue closes -- that is when its stored files become dead, so the
 * trigger and the condition are the same event and no schedule has to approximate it.
 * Anything one run misses is taken by the next issue to close.
 *
 * Usage:
 *   prune_atoma_data.ts [--repo OWNER/REPO] [--dry-run]
 *
 * `--dry-run` prints what it would delete and touches nothing, which is how to look at
 * a store before letting this loose on it.
 *
 * ## Why deleting files rather than rewriting history
 *
 * The history is where the bytes are, and only a force-push reclaims them. That is
 * exactly what must not happen here: sessions are written by runs that are going on
 * right now, from jobs that fetched this branch minutes ago, and a rewritten history
 * turns their next push into a conflict they have no handling for. So this removes
 * files and leaves the history, which keeps the working tree bounded and lets the
 * history grow slowly. Reclaiming it is a separate decision nobody has had to make yet.
 */
import { parseArgs } from "node:util";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghPaginated, gitRun } from "../lib/gh.ts";
import { getLabel } from "../lib/config.ts";
import { prunablePaths, pruneCommitMessage } from "../domain/atoma-data-pruning.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

const BRANCH = "atoma-data";

function log(message: string): void {
  console.error(`[prune-atoma-data] ${message}`);
}

interface IssueState {
  number: number;
  state: string;
  labels?: { name?: string }[];
  pull_request?: unknown;
}

/**
 * Every issue's state and labels, in one pass rather than one request per issue.
 *
 * A store with a hundred issues in it would otherwise be a hundred requests every time
 * an issue closes, which is the kind of cost that gets a job turned off.
 */
function issueStates(repo: string): Map<number, IssueState> {
  const byNumber = new Map<number, IssueState>();
  for (const state of ["open", "closed"]) {
    const page = ghPaginated<IssueState>("api", `repos/${repo}/issues?state=${state}&per_page=100`);
    for (const issue of page) {
      // Pull requests come back from this endpoint too, and nothing here is stored
      // under a pull request's number.
      if (issue.pull_request !== undefined) continue;
      byNumber.set(issue.number, issue);
    }
  }
  return byNumber;
}

/**
 * Whether this issue's stored files are dead.
 *
 * Three ways to answer no, and the two cautious ones matter more than the obvious one:
 * an issue that cannot be read is not evidence of anything, and an issue a run is
 * working on right now can be closed and still be live -- an agent closes the issue and
 * the job keeps going, so deleting under it would make its next save resurrect what
 * this just removed.
 */
function isOver(states: Map<number, IssueState>, inProgressLabel: string, issue: number): boolean {
  const found = states.get(issue);
  if (found === undefined) {
    log(`#${issue} could not be read; leaving its files alone`);
    return false;
  }
  if (found.state !== "closed") return false;
  if ((found.labels ?? []).some((label) => label.name === inProgressLabel)) {
    log(`#${issue} is closed but still carries ${inProgressLabel}; leaving its files alone`);
    return false;
  }
  return true;
}

function storedPaths(): string[] {
  const listed = gitRun("ls-tree", "-r", "--name-only", `origin/${BRANCH}`);
  if (listed.code !== 0) {
    log(`could not list ${BRANCH}: ${listed.stderr || listed.stdout}`);
    return [];
  }
  return listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { repo: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!repo) {
    console.error("usage: prune_atoma_data.ts [--repo OWNER/REPO] [--dry-run]");
    process.exit(2);
  }

  if (gitRun("fetch", "origin", BRANCH).code !== 0) {
    log(`${BRANCH} does not exist; nothing to prune`);
    return;
  }

  const paths = storedPaths();
  const states = issueStates(repo);
  const inProgress = getLabel("in_progress");
  const decision = prunablePaths(paths, (issue) => isOver(states, inProgress, issue));

  log(`${paths.length} stored files, ${decision.paths.length} belong to closed issues`);
  if (decision.paths.length === 0) return;
  log(`issues: ${decision.issues.map((n) => `#${n}`).join(", ")}`);

  if (values["dry-run"]) {
    for (const path of decision.paths) console.error(`  would delete ${path}`);
    return;
  }

  // A worktree, like `saveSession`: the current checkout may hold work in progress,
  // and this must not be the thing that disturbs it.
  const worktree = mkdtempSync(join(tmpdir(), "atoma-data-prune-"));
  try {
    gitRun("worktree", "add", worktree, `origin/${BRANCH}`);
    const git = (...args: string[]) =>
      Bun.spawnSync({ cmd: ["git", ...args], cwd: worktree, stdout: "pipe", stderr: "pipe" });
    git("config", "user.email", "action@github.com");
    git("config", "user.name", "GitHub Actions");

    for (let attempt = 1; attempt <= 3; attempt++) {
      git("fetch", "origin", BRANCH);
      git("reset", "--hard", `origin/${BRANCH}`);

      // Re-checked against the freshly fetched tree: a run that finished since the
      // listing above may have written a file this decision does not know about, and
      // `git rm` on a path that is no longer there fails the whole batch.
      const present = decision.paths.filter((path) => existsSync(join(worktree, path)));
      if (present.length === 0) {
        log("nothing left to delete after the refetch");
        return;
      }
      git("rm", "-q", "--", ...present);
      git("commit", "-m", pruneCommitMessage({ ...decision, paths: present }));

      if ((git("push", "origin", `HEAD:${BRANCH}`).exitCode ?? 1) === 0) {
        log(`deleted ${present.length} files`);
        return;
      }
      log(`push attempt ${attempt} lost a race; refetching`);
      Bun.sleepSync(attempt * 2000);
    }
    log("gave up after three attempts; the next issue to close will try again");
  } finally {
    gitRun("worktree", "remove", "--force", worktree);
    rmSync(worktree, { recursive: true, force: true });
  }
}

if (import.meta.main) main();

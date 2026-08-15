#!/usr/bin/env bun
/**
 * resolve_issue_branch.ts — says which branch a run should check out, if any.
 *
 * Branches are created when work is committed, not when a run starts. Most runs
 * never commit: a run that reports a CI failure, confirms a merge, or closes an
 * issue produces no code. Creating a branch for those left one behind per run,
 * and the repository had accumulated 72 of them.
 *
 * Deciding by what a run does rather than by which agent it is matters. Agents
 * are the adopter's to edit, rename and add to, so nothing here may key off an
 * agent's name — a branch appears when something is committed, whoever committed
 * it.
 *
 * Usage:
 *   resolve_issue_branch.ts --repo owner/name --issue 12
 *
 * Writes `branch=<name-or-empty>` to $GITHUB_OUTPUT. Empty means start from the
 * base branch; `commit_and_push` names a new branch if the run turns out to need
 * one.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { branchToResume } from "../domain/issue-branch.ts";
import { collectIssueBranches } from "../lib/issue-branches.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface ResolveIssueBranchArgs {
  repo: string;
  issue: string;
}

export const ref = defineScript<ResolveIssueBranchArgs>(import.meta.url);

function log(message: string): void {
  console.error(`[atoma-issue-branch] ${message}`);
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { repo: { type: "string" }, issue: { type: "string" } },
  });

  const repo = (values.repo ?? "").trim();
  const issue = Number(values.issue);
  const githubOutput = process.env.GITHUB_OUTPUT;

  // Never fails the run. A run that cannot resolve its branch should start on the
  // base and let `commit_and_push` sort it out, not stop before the agent has
  // said anything.
  let branch = "";
  if (repo && Number.isInteger(issue) && issue > 0) {
    branch = branchToResume(collectIssueBranches(repo, issue), issue);
  } else {
    log("missing --repo or --issue; staying on the base branch");
  }

  log(branch ? `resuming ${branch}` : "no branch to resume; starting from the base branch");
  if (githubOutput) appendFileSync(githubOutput, `branch=${branch}\n`);
}

if (import.meta.main) main();

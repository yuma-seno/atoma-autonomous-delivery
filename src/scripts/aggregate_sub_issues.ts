#!/usr/bin/env bun
/**
 * aggregate_sub_issues.ts — Called after a PR merges and its linked
 * sub-issue's orchestrator parent is known. If any sibling sub-issues are
 * still open, just posts a progress comment. Once all siblings are done,
 * aggregates their results into the orchestrator's session (stored on the
 * orphan `atoma-data` branch) and re-dispatches the orchestrator.
 *
 * Thin CLI wrapper around lib/aggregation.ts's shared dispatch gate -- see that
 * module's doc comment for the other two callers of the same gate and for the
 * race between them.
 *
 * Usage:
 *   aggregate_sub_issues.ts --repo OWNER/REPO --parent N --closed-num N
 */
import { parseArgs } from "node:util";
import { gh } from "../lib/gh.ts";
import { defineScript } from "./lib/script-ref.ts";
import { dispatchOrchestratorIfReady } from "../lib/aggregation.ts";
import { injectSubResults, type Session } from "../lib/inject-sub-results.ts";
import { PARENT_TAG } from "../lib/tags.ts";
import { restoreSession, saveSession, sessionTargetPath } from "./lib/atoma-data.ts";

export interface AggregateSubIssuesArgs {
  repo: string;
  parent: string | number;
  "closed-num": string | number;
}

export const ref = defineScript<AggregateSubIssuesArgs>(import.meta.url);

/**
 * Every sub-issue linked to `parent`, open or closed.
 *
 * The `--search` narrows server-side, but GitHub's issue search tokenizes, so it
 * is a prefilter and not the predicate: the same query returns `atoma:parent=50`
 * for a query of `5`. `PARENT_TAG.read` is the predicate, because it is anchored
 * on the tag's real wire format. The previous version filtered with jq
 * `contains("atoma:parent=<n>")`, an unanchored substring test, so aggregating
 * parent #5 collected every sub-issue of #50 through #59 and fed their results
 * into #5's orchestrator session.
 *
 * `--limit` is explicit because `gh issue list` defaults to 30 and truncates
 * silently, which for a plan with more sub-tasks than that would look like
 * results simply going missing.
 */
function linkedSubIssues(repo: string, parent: number): number[] {
  const { code, stdout, stderr } = gh(
    "issue", "list", "--repo", repo, "--state", "all", "--limit", "200",
    "--search", `atoma:parent=${parent} in:body`,
    "--json", "number,body",
  );
  if (code !== 0) {
    throw new Error(`could not list sub-issues of #${parent}: ${stderr || stdout}`);
  }
  const issues = (stdout ? JSON.parse(stdout) : []) as { number: number; body?: string }[];
  return issues.filter((issue) => PARENT_TAG.read(issue.body ?? "") === parent).map((issue) => issue.number);
}

/**
 * Injects every linked sub-issue's result into the orchestrator's persisted
 * session on the `atoma-data` branch.
 *
 * Reads and writes through lib/atoma-data.ts rather than driving git here. That
 * module's `saveSession` already owns the part that is easy to get wrong -- it
 * creates the branch if absent, holds the push-retry loop for the races that are
 * expected when sibling agents finish together, and does all of it in a
 * throwaway worktree so the job's own checkout is untouched. This function used
 * to reimplement that with `git checkout -B atoma-data` in the main checkout
 * (and `git rm -rf .` on the branch-missing path), which worked only because
 * nothing in this job reads a file afterwards.
 */
function injectResultsIntoOrchestratorSession(repo: string, parent: number): void {
  const subIssues = linkedSubIssues(repo, parent);
  console.error(`Sub-issues of #${parent}: ${subIssues.join(", ") || "(none)"}`);

  const sessionPath = sessionTargetPath("issue", parent, "orchestrator");
  const existing = restoreSession(sessionPath);
  const session: Session = existing ? (JSON.parse(existing) as Session) : { messages: [] };

  const updated = injectSubResults(session, repo, subIssues);
  const message = `atoma: inject sub-issue results for parent #${parent}`;
  if (!saveSession(sessionPath, JSON.stringify(updated, null, 2), message)) {
    console.error(`::warning::Failed to save session to atoma-data:${sessionPath} after all retries.`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      parent: { type: "string" },
      "closed-num": { type: "string" },
    },
  });
  const repo = values.repo;
  const parent = values.parent;
  const closedNum = values["closed-num"];
  if (!repo || !parent || !closedNum) {
    console.error("usage: aggregate_sub_issues.ts --repo OWNER/REPO --parent N --closed-num N");
    process.exit(2);
  }

  console.error(`PR merged (sub-issue #${closedNum}, parent #${parent}). Checking siblings...`);

  const result = await dispatchOrchestratorIfReady({
    repo,
    parent: Number(parent),
    closedNum: Number(closedNum),
    // We already KNOW this sub-issue's work is done (its PR just merged)
    // regardless of whether GitHub's live issue state reflects that yet
    // (native "Closes #N" auto-close is unreliable under the Actions
    // GITHUB_TOKEN) -- excluding it makes this check reliably correct on
    // its first (and normally only) run instead of depending on that timing.
    exclude: true,
    progressMessage: (remaining) => `Atoma: Sub-task #${closedNum} completed. ${remaining} sub-task(s) still in progress.`,
    beforeDispatch: () => injectResultsIntoOrchestratorSession(repo, Number(parent)),
  });

  if (!result.ready) {
    console.error("Not all sub-tasks done yet.");
  } else if (!result.dispatched) {
    // Two causes, and the gate does not distinguish them: another caller got
    // there first (the normal race, harmless), or the dispatch itself failed and
    // logged the gh error above. Say both rather than assert the benign one.
    console.error(
      `Orchestrator was not dispatched for #${closedNum}: another caller already handled this ` +
        `completion, or the dispatch failed -- check for a WARN above.`,
    );
  } else {
    console.error("All sub-tasks completed! Orchestrator re-invoked.");
  }
}

if (import.meta.main) void main();


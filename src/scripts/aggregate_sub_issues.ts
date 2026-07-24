#!/usr/bin/env bun
/**
 * aggregate_sub_issues.ts — Called after a PR merges and its linked
 * sub-issue's orchestrator parent is known. If any sibling sub-issues are
 * still open, just posts a progress comment. Once all siblings are done,
 * aggregates their results into the orchestrator's session (stored on the
 * orphan `atoma-data` branch) and re-dispatches the orchestrator.
 *
 * Thin CLI wrapper around lib/aggregation.ts's shared dispatch gate --
 * see that module's doc comment for why this exact gate is also used by
 * dispatch_orchestrator_if_ready.ts and dispatch_if_siblings_done.ts.
 *
 * Usage:
 *   aggregate_sub_issues.ts --repo OWNER/REPO --parent N --closed-num N
 */
import { parseArgs } from "node:util";
import { dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { gh, gitRun } from "../lib/gh.ts";
import { defineScript } from "./lib/script-ref.ts";
import { dispatchOrchestratorIfReady } from "../lib/aggregation.ts";
import { injectSubResults, type Session } from "../lib/inject-sub-results.ts";

export interface AggregateSubIssuesArgs {
  repo: string;
  parent: string | number;
  "closed-num": string | number;
}

export const ref = defineScript<AggregateSubIssuesArgs>(import.meta.url);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches every sub-issue linked to `parent` (open or closed) and injects
 * their results into the orchestrator's persisted session on the orphan
 * `atoma-data` branch, retrying on push races -- multiple parents can
 * finish aggregation around the same time, all pushing to the same
 * atoma-data branch, so a race is expected, not exceptional. Re-pulls the
 * latest tip on every attempt and, if the push still loses the race,
 * resets and retries from scratch -- safe because each parent only ever
 * touches its own uniquely-named sessionPath, so a reset can never discard
 * another parent's concurrently-pushed session.
 */
async function injectResultsIntoOrchestratorSession(repo: string, parent: string): Promise<void> {
  const { stdout: allSubsOut } = gh(
    "issue", "list", "--repo", repo, "--state", "all",
    "--json", "number,title,body",
    "--jq", `[.[] | select(.body | contains("atoma:parent=#${parent}")) | .number] | join(",")`,
  );
  const subIssues = allSubsOut.trim().split(",").filter(Boolean).map(Number);
  console.log(`All sub-issues for parent #${parent}: ${subIssues.join(",")}`);

  const sessionPath = `sessions/issue-${parent}-orchestrator.json`;

  gitRun("config", "user.email", "action@github.com");
  gitRun("config", "user.name", "GitHub Actions");

  let saved = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (gitRun("fetch", "origin", "atoma-data").code === 0) {
      gitRun("checkout", "-B", "atoma-data", "origin/atoma-data");
    } else {
      gitRun("checkout", "--orphan", "atoma-data");
      gitRun("rm", "-rf", ".");
    }

    const session: Session =
      gitRun("cat-file", "-e", `HEAD:${sessionPath}`).code === 0
        ? (JSON.parse(gitRun("show", `HEAD:${sessionPath}`).stdout) as Session)
        : { messages: [] };

    const updated = injectSubResults(session, repo, subIssues);

    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, JSON.stringify(updated, null, 2));
    gitRun("add", sessionPath);

    if (gitRun("diff", "--cached", "--quiet").code === 0) {
      console.log("No changes to session; skipping commit.");
      saved = true;
      break;
    }

    gitRun("commit", "-m", `atoma: inject sub-issue results for parent #${parent}`);

    if (gitRun("push", "origin", "atoma-data").code === 0) {
      saved = true;
      break;
    }

    console.log(`Push attempt ${attempt} failed (concurrent push) -- resetting and retrying with a fresh pull...`);
    await sleep(attempt * 2000);
  }

  if (!saved) {
    console.log(`::warning::Failed to save session to atoma-data:${sessionPath} after all retries.`);
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

  console.log(`PR merged (sub-issue #${closedNum}, parent #${parent}). Checking siblings...`);

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
    beforeDispatch: () => injectResultsIntoOrchestratorSession(repo, parent),
  });

  if (!result.ready) {
    console.log("Not all sub-tasks done yet.");
  } else if (!result.dispatched) {
    console.log(`Aggregation for sub-issue #${closedNum} already dispatched by another caller; skipping.`);
  } else {
    console.log("All sub-tasks completed! Orchestrator re-invoked.");
  }
}

if (import.meta.main) void main();


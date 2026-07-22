#!/usr/bin/env bun
/**
 * aggregate_sub_issues.ts — Called after a PR merges and its linked
 * sub-issue's orchestrator parent is known. If any sibling sub-issues are
 * still open, just posts a progress comment. Once all siblings are done,
 * aggregates their results into the orchestrator's session (stored on the
 * orphan `atoma-data` branch) and re-dispatches the orchestrator.
 *
 * Usage:
 *   aggregate_sub_issues.ts --repo OWNER/REPO --parent N --closed-num N
 */
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gh, gitRun } from "./lib/gh.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export interface AggregateSubIssuesArgs {
  repo: string;
  parent: string | number;
  "closed-num": string | number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  gitRun("config", "user.email", "action@github.com");
  gitRun("config", "user.name", "GitHub Actions");

  console.log(`PR merged (sub-issue #${closedNum}, parent #${parent}). Checking siblings...`);

  const siblingsOut = Bun.spawnSync({
    cmd: ["bun", "run", join(SCRIPT_DIR, "check_open_siblings.ts"), "--repo", repo, "--parent", parent],
    stdout: "pipe",
    stderr: "inherit",
  });
  const siblingCount = Number(siblingsOut.stdout.toString("utf8").trim() || "0");

  if (siblingCount > 0) {
    console.log(`Still ${siblingCount} open sibling(s). Notifying progress...`);
    gh(
      "issue", "comment", parent,
      "--body", `<!-- atoma:sub-result:#${closedNum} -->\nAtoma: Sub-task #${closedNum} completed. ${siblingCount} sub-task(s) still in progress.`,
    );
    console.log("Not all sub-tasks done yet.");
    return;
  }

  console.log("All sub-tasks completed! Preparing orchestrator re-invocation...");

  const { stdout: allSubsOut } = gh(
    "issue", "list",
    "--repo", repo,
    "--state", "all",
    "--json", "number,title,body",
    "--jq", `[.[] | select(.body | contains("atoma:parent=#${parent}")) | .number] | join(",")`,
  );
  const allSubs = allSubsOut.trim();
  console.log(`All sub-issues for parent #${parent}: ${allSubs}`);

  const sessionPath = `sessions/issue-${parent}-orchestrator.json`;

  // Multiple parents can finish aggregation around the same time, all
  // pushing to the same atoma-data branch, so a push race is expected, not
  // exceptional. Re-pull the latest tip on every attempt and, if the push
  // still loses the race, reset and retry from scratch -- safe because each
  // parent only ever touches its own uniquely-named sessionPath, so a reset
  // can never discard another parent's concurrently-pushed session.
  let saved = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (gitRun("fetch", "origin", "atoma-data").code === 0) {
      gitRun("checkout", "-B", "atoma-data", "origin/atoma-data");
    } else {
      gitRun("checkout", "--orphan", "atoma-data");
      gitRun("rm", "-rf", ".");
    }

    if (gitRun("cat-file", "-e", `HEAD:${sessionPath}`).code === 0) {
      const shown = gitRun("show", `HEAD:${sessionPath}`);
      writeFileSync("session.json", shown.stdout);
    } else {
      writeFileSync("session.json", JSON.stringify({ messages: [] }));
    }

    const injectResult = Bun.spawnSync({
      cmd: [
        "bun", "run", join(SCRIPT_DIR, "inject_sub_results.ts"),
        "--session", "session.json",
        "--repo", repo,
        "--parent", parent,
        "--sub-issues", allSubs,
        "--out", "session.json",
      ],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (injectResult.exitCode !== 0) {
      console.error("inject_sub_results.ts failed; aborting aggregation");
      break;
    }

    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, readFileSync("session.json"));
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

  gh(
    "issue", "comment", parent,
    "--body", `<!-- atoma:sub-result:#${closedNum} -->\nAtoma: All sub-tasks completed. Re-starting orchestrator for aggregation.`,
  );

  const notifyOut = Bun.spawnSync({
    cmd: ["bun", "run", join(SCRIPT_DIR, "resolve_notify.ts"), "--repo", repo, "--number", parent],
    stdout: "pipe",
  });
  const notify = notifyOut.stdout.toString("utf8").trim();

  gh(
    "workflow", "run", "atoma-runner.yml",
    "--field", "agent=orchestrator",
    "--field", `number=${parent}`,
    "--field", "type=issue",
    "--field", `notify=${notify}`,
  );
}

if (import.meta.main) void main();

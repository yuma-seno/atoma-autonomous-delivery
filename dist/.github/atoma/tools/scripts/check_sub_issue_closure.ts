#!/usr/bin/env bun
/**
 * check_sub_issue_closure.ts — Determine whether a just-closed issue is an
 * Atoma sub-issue (has an `<!-- atoma:parent=#N -->` tag) and, if so,
 * whether it was already closed via a merged PR (in which case
 * atoma-pr-merged.wac.ts already handled aggregation, and this fallback
 * path must skip to avoid dispatching the orchestrator twice).
 *
 * Env: CLOSED_NUM, GITHUB_EVENT_PATH, OWNER, REPO
 * Writes to $GITHUB_OUTPUT: is_sub_issue, parent_number, closed_via_pr
 */
import { readFileSync, appendFileSync } from "node:fs";
import { ghGraphql } from "./lib/gh.ts";

interface GithubIssueClosedEvent {
  issue?: { body?: string };
}

function main(): void {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const closedNum = process.env.CLOSED_NUM ?? "";
  const owner = process.env.OWNER ?? "";
  const repo = process.env.REPO ?? "";
  const githubOutput = process.env.GITHUB_OUTPUT;

  const event = eventPath ? (JSON.parse(readFileSync(eventPath, "utf8")) as GithubIssueClosedEvent) : {};
  const body = event.issue?.body ?? "";
  const match = /<!--\s*atoma:parent=#(\d+)\s*-->/.exec(body);

  if (!match) {
    if (githubOutput) appendFileSync(githubOutput, "is_sub_issue=false\n");
    return;
  }

  const parent = match[1]!;
  console.error(`Sub-issue #${closedNum} closed — parent #${parent}`);

  // atoma-pr-merged.wac.ts (pull_request_target: closed) is the PRIMARY
  // aggregation path and already handles sub-issues auto-closed by a merged
  // PR's "Closes #N". A merged PR's auto-close ALSO fires this `issues:
  // closed` event (GitHub only suppresses that cascade for GITHUB_TOKEN-
  // driven merges — under the default merge_policy: "manual", a human/agent
  // merges via their own credentials, so both workflows fire). Without this
  // check, the orchestrator gets dispatched twice.
  let closedViaPr = false;
  try {
    const data = ghGraphql<{
      repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number }[] } } };
    }>(
      "query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){closedByPullRequestsReferences(first: 1) { nodes { number } }}}}",
      { owner, repo, num: Number(closedNum) },
    );
    const mergedPr = data.repository.issue.closedByPullRequestsReferences.nodes[0]?.number;
    if (mergedPr) {
      console.error(`Closed via merged PR #${mergedPr} — already handled by atoma-pr-merged.yml. Skipping.`);
      closedViaPr = true;
    }
  } catch {
    // best-effort; treat as not closed via PR
  }

  if (githubOutput) {
    appendFileSync(githubOutput, ["is_sub_issue=true", `parent_number=${parent}`, `closed_via_pr=${closedViaPr}`].join("\n") + "\n");
  }
}

if (import.meta.main) main();

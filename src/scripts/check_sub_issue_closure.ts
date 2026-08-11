#!/usr/bin/env bun
/**
 * check_sub_issue_closure.ts — Determine whether a just-closed issue is an
 * Atoma sub-issue (has an `<!-- atoma:parent=N -->` tag) and, if so,
 * whether it was already closed via a merged PR (in which case
 * atoma-pr-merged.wac.ts already handled aggregation, and this fallback
 * path must skip to avoid dispatching the orchestrator twice).
 *
 * Env: CLOSED_NUM, GITHUB_EVENT_PATH, OWNER, REPO
 * Writes to $GITHUB_OUTPUT: is_sub_issue, parent_number, closed_via_pr
 */
import { readFileSync, appendFileSync } from "node:fs";
import { ghGraphql } from "../lib/gh.ts";
import { defineScript } from "./lib/script-ref.ts";
import { PARENT_TAG } from "../lib/tags.ts";

export const ref = defineScript(import.meta.url);

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
  const parent = PARENT_TAG.read(body);

  if (parent === undefined) {
    if (githubOutput) appendFileSync(githubOutput, "is_sub_issue=false\n");
    return;
  }

  console.error(`Sub-issue #${closedNum} closed — parent #${parent}`);

  // atoma-pr-merged.wac.ts (pull_request_target: closed) is the PRIMARY
  // aggregation path and already handles sub-issues auto-closed by a merged
  // PR's "Closes #N". This path is the fallback, and whether the two can both
  // fire for one completion turns on WHO performed the merge, because GitHub
  // suppresses the event cascade only for actions taken with GITHUB_TOKEN:
  //
  // - An agent merge (`github__merge_pr`, which the shipped `merge_policy:
  //   "auto"` permits) runs as GITHUB_TOKEN, so the auto-close fires no
  //   `issues: closed` event and this workflow never starts. The guard below
  //   costs nothing.
  // - A person merging from the GitHub UI — the only route under
  //   `merge_policy: "manual"`, and always available regardless — uses their
  //   own credentials, so the auto-close DOES fire this workflow while
  //   atoma-pr-merged is already handling the same completion.
  //
  // The second case is why the check exists: without it the orchestrator gets
  // dispatched twice. lib/aggregation.ts's `atoma:aggregated` marker would
  // catch the duplicate anyway, but only after a second run has started.
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

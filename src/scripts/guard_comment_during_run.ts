#!/usr/bin/env bun
/**
 * guard_comment_during_run.ts — While an issue/PR carries the configured
 * "in_progress" label (an Atoma agent run is currently active on it), a new
 * human comment would otherwise sit unseen until the current run finishes
 * (or worse, race a slash-command dispatch against the in-flight run).
 * Instead: delete the comment immediately and notify its author via mention
 * so they know to wait and re-comment once the run concludes. No-ops
 * quietly (leaves the comment alone) when the label isn't present.
 *
 * Usage:
 *   guard_comment_during_run.ts --number N --comment-id ID --commenter LOGIN
 * Writes `blocked=true|false` to $GITHUB_OUTPUT.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gh } from "../lib/gh.ts";
import { getLabel } from "../lib/config.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface GuardCommentDuringRunArgs {
  number: string | number;
  "comment-id": string | number;
  commenter: string;
}

export const ref = defineScript<GuardCommentDuringRunArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      "comment-id": { type: "string" },
      commenter: { type: "string" },
    },
  });

  if (!values.number || !values["comment-id"]) {
    console.error("usage: guard_comment_during_run.ts --number N --comment-id ID --commenter LOGIN");
    process.exit(2);
  }

  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const label = getLabel("in_progress", "atoma/in-progress");
  const githubOutput = process.env.GITHUB_OUTPUT;

  const { code, stdout } = gh(
    "issue", "view", String(values.number), "--repo", repo,
    "--json", "labels", "--jq", `([.labels[].name] | index("${label}")) != null`,
  );
  // A failed lookup is not "no label". This script exists to keep a comment out
  // of a race with a running agent, so the answer it could not determine must not
  // be the one that lets the comment through.
  if (code !== 0) {
    console.error(
      `Could not read the labels on #${values.number}, so this cannot tell whether a run is in progress.`,
    );
    process.exit(1);
  }
  const inProgress = stdout.trim() === "true";

  if (!inProgress) {
    if (githubOutput) appendFileSync(githubOutput, "blocked=false\n");
    return;
  }

  const { code: delCode, stdout: delOut, stderr: delErr } = gh(
    "api", "--method", "DELETE", `repos/${repo}/issues/comments/${values["comment-id"]}`,
  );
  const deleted = delCode === 0;
  if (!deleted) {
    console.error(`Warning: failed to delete comment #${values["comment-id"]} on #${values.number}: ${delErr || delOut}`);
  }

  // Says which of the two actually happened. Telling someone their comment was
  // removed when it is still on the page — and will not be parsed as a command
  // either, since `blocked=true` suppresses that — leaves them waiting for a run
  // that is not coming, with the evidence in front of them saying otherwise.
  const mention = values.commenter ? `@${values.commenter} ` : "";
  const what = deleted
    ? "Your comment was removed because"
    : "Your comment could not be removed, and will not be acted on, because";
  gh(
    "issue", "comment", String(values.number), "--repo", repo,
    "--body",
    `${mention}${what} Atoma is currently processing this issue/PR (the \`${label}\` label is active). Please wait for the current run to finish, then comment again.`,
  );

  if (githubOutput) appendFileSync(githubOutput, "blocked=true\n");
  console.error(`Deleted comment #${values["comment-id"]} on #${values.number} (in-progress guard) and notified ${values.commenter || "(unknown)"}.`);
}

if (import.meta.main) main();

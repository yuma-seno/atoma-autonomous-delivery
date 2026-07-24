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
  const inProgress = code === 0 && stdout.trim() === "true";

  if (!inProgress) {
    if (githubOutput) appendFileSync(githubOutput, "blocked=false\n");
    return;
  }

  const { code: delCode, stdout: delOut, stderr: delErr } = gh(
    "api", "--method", "DELETE", `repos/${repo}/issues/comments/${values["comment-id"]}`,
  );
  if (delCode !== 0) {
    console.error(`Warning: failed to delete comment #${values["comment-id"]} on #${values.number}: ${delErr || delOut}`);
  }

  const mention = values.commenter ? `@${values.commenter} ` : "";
  gh(
    "issue", "comment", String(values.number), "--repo", repo,
    "--body",
    `${mention}Your comment was removed because Atoma is currently processing this issue/PR (the \`${label}\` label is active). Please wait for the current run to finish, then comment again.`,
  );

  if (githubOutput) appendFileSync(githubOutput, "blocked=true\n");
  console.error(`Deleted comment #${values["comment-id"]} on #${values.number} (in-progress guard) and notified ${values.commenter || "(unknown)"}.`);
}

if (import.meta.main) main();

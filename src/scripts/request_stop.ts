#!/usr/bin/env bun
/**
 * request_stop.ts — Act on a `/stop` comment: remove it, and post the request the
 * running job polls for.
 *
 * ## Why the request is a comment
 *
 * Nothing outside a workflow job can reach into that job's filesystem, so a stop has
 * to be left somewhere both sides can see. A comment is that place, and it is also
 * the record of who asked and when — a label would have needed a second thing to
 * carry the same information.
 *
 * The running job polls for `STOP_TAG` and, when it finds one newer than its own
 * start, writes the file `atoma run --stop-file` is watching. See `watch_for_stop.ts`.
 *
 * ## Why the human's comment is deleted
 *
 * A stop must not become the next run's context. The whole point is that the run is
 * paused rather than told something; a `/stop` sitting in the session would be read
 * by the resumed agent as an instruction it has to account for.
 *
 * The notice this posts is tagged `llm-context=exclude`, so it is dropped by
 * `reconcile_github_session.ts` on the way into a session for the same reason.
 *
 * ## Why it says the comment was deleted
 *
 * Because the existing in-progress guard also deletes comments, and says so. Someone
 * whose `/stop` vanished with no explanation would have no way to tell "your stop is
 * being acted on" from "your comment was refused because a run is in progress".
 *
 * Usage:
 *   request_stop.ts --number N --comment-id ID --commenter LOGIN
 */
import { parseArgs } from "node:util";
import { gh } from "../lib/gh.ts";
import { getLabel } from "../lib/config.ts";
import { LLM_CONTEXT_TAG, PARENT_TAG, STOP_TAG } from "../lib/tags.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface RequestStopArgs {
  number: string | number;
  "comment-id": string | number;
  commenter: string;
}

export const ref = defineScript<RequestStopArgs>(import.meta.url);

/**
 * Sub-issues of `parent` that are currently claimed by an agent.
 *
 * A parent keeps the in-progress label for as long as its chain is running, and that
 * chain may be running on a sub-issue — so a `/stop` on the parent can be aimed at
 * the wrong number without anyone doing anything wrong. This does not stop them:
 * their sessions are separate, and stopping work somebody did not ask to stop is a
 * worse failure than naming it and letting them choose.
 *
 * Every failure here is silent. The stop request is the thing that matters and it has
 * already been posted; a list of candidates is an improvement to the notice, not a
 * precondition for it.
 */
function runningChildren(repo: string, parent: number): number[] {
  const label = getLabel("in_progress");
  const { code, stdout } = gh(
    "issue", "list", "--repo", repo, "--state", "open", "--limit", "200",
    "--search", `atoma:parent=${parent} in:body`,
    "--label", label,
    "--json", "number,body",
  );
  if (code !== 0) return [];
  try {
    const issues = JSON.parse(stdout || "[]") as { number: number; body?: string }[];
    // The search is a prefilter, not the predicate: GitHub tokenizes, so a query for
    // `atoma:parent=5` also returns the sub-issues of #50. `PARENT_TAG.read` is
    // anchored on the tag's real wire format. Same trap as `aggregate_sub_issues.ts`.
    return issues.filter((i) => PARENT_TAG.read(i.body ?? "") === parent).map((i) => i.number);
  } catch {
    return [];
  }
}

/** The notice, as the person who typed `/stop` will read it. */
export function stopRequestedNotice(commenter: string, deleted: boolean, children: number[]): string {
  const mention = commenter ? `@${commenter} ` : "";
  const lines = [
    LLM_CONTEXT_TAG.write("exclude"),
    STOP_TAG.write("requested"),
    `${mention}Atoma: stop requested.`,
    "",
    deleted
      ? "Your `/stop` comment was removed so it does not become part of the agent's context."
      : "Your `/stop` comment could not be removed, so it may end up in the agent's context.",
    "",
    // The lag is real and it is the thing people will misread. A stop is picked up on
    // the next poll and taken at the next turn, so the agent can finish a tool call
    // and start another one after the request. Without this line that reads as the
    // command having done nothing.
    "The run will stop after its current step, so it may take a minute. Nothing is lost when it does: the session is saved and can be continued.",
  ];
  if (children.length > 0) {
    lines.push(
      "",
      `This issue also has work running on ${children.map((n) => `#${n}`).join(", ")}. ` +
        "A stop here does not reach those — comment `/stop` on each one you want stopped.",
    );
  }
  return lines.join("\n");
}

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
    console.error("usage: request_stop.ts --number N --comment-id ID --commenter LOGIN");
    process.exit(2);
  }

  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const number = String(values.number);

  const { code: delCode, stdout: delOut, stderr: delErr } = gh(
    "api", "--method", "DELETE", `repos/${repo}/issues/comments/${values["comment-id"]}`,
  );
  const deleted = delCode === 0;
  if (!deleted) {
    console.error(`Warning: failed to delete comment #${values["comment-id"]} on #${number}: ${delErr || delOut}`);
  }

  const children = runningChildren(repo, Number(number));

  const { code, stdout, stderr } = gh(
    "issue", "comment", number, "--repo", repo,
    "--body", stopRequestedNotice(values.commenter ?? "", deleted, children),
  );
  // Fatal, unlike the deletion. This comment IS the request: without it the run
  // polls, finds nothing, and keeps going, and the person is told a stop is coming
  // that never arrives.
  if (code !== 0) {
    console.error(`Could not post the stop request on #${number}: ${stderr || stdout}`);
    process.exit(1);
  }

  console.error(`Stop requested on #${number}${children.length ? ` (children running: ${children.join(", ")})` : ""}`);
}

if (import.meta.main) main();

#!/usr/bin/env bun
/**
 * watch_for_stop.ts — Poll an issue/PR for a stop request and, when one arrives,
 * create the file `atoma run --stop-file` is watching.
 *
 * Runs in the background for the length of the agent step and is killed with it.
 *
 * ## Why polling
 *
 * A stop is decided outside the job, and nothing outside a job can write into that
 * job's filesystem. Something inside has to go and look. GitHub has no push channel
 * a running job can subscribe to, so this is the only shape available, and its cost
 * is one API request per interval — around 110 for a full-length run.
 *
 * ## Why it only looks at requests newer than the run
 *
 * A stop from last week is not a stop of this run. Without the cutoff, an issue that
 * was ever stopped could never be worked on again: every run would find the old
 * request on its first poll and stop before doing anything.
 *
 * ## Why it never fails the step
 *
 * It is a background process inside the step that runs the agent. Exiting non-zero
 * would say the run failed, and "GitHub returned a 502 while we were polling" is not
 * a failed run. A poll that cannot answer is treated as "no stop yet", which is the
 * answer that lets work continue.
 *
 * Usage:
 *   watch_for_stop.ts --number N --stop-file PATH --since ISO8601 [--interval-seconds N]
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gh } from "../lib/gh.ts";
import { STOP_TAG } from "../lib/tags.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface WatchForStopArgs {
  number: string | number;
  "stop-file": string;
  /** ISO 8601. Requests at or before this instant belong to an earlier run. */
  since: string;
  "interval-seconds"?: string | number;
}

export const ref = defineScript<WatchForStopArgs>(import.meta.url);

/**
 * 30 seconds.
 *
 * The trade is between how long a person waits after typing `/stop` and how much of
 * the repository's hourly API budget one run spends. At 30 seconds a full-length run
 * costs about 110 requests against a 1000/hour limit, and a person waits at most half
 * a minute plus however long the agent's current tool call takes -- which is usually
 * the larger half.
 */
const DEFAULT_INTERVAL_SECONDS = 30;

export interface StopComment {
  body?: string;
  created_at?: string;
}

/**
 * Whether any of these comments is a stop request belonging to this run.
 *
 * Exported for its test: the cutoff is the part that is easy to get subtly wrong, and
 * getting it wrong in the permissive direction means an issue that can never be
 * worked on again.
 */
export function stopRequested(comments: StopComment[], since: Date): boolean {
  return comments.some((c) => {
    if (!STOP_TAG.has(c.body ?? "")) return false;
    const at = c.created_at ? Date.parse(c.created_at) : NaN;
    // An unparseable timestamp is not a reason to ignore a stop somebody asked for.
    // The failure it risks -- stopping one run early -- is recoverable by a comment;
    // the other direction is a run nobody can interrupt.
    return Number.isNaN(at) || at > since.getTime();
  });
}

function poll(repo: string, number: string, since: Date): boolean {
  const { code, stdout } = gh(
    "api", `repos/${repo}/issues/${number}/comments`,
    "--method", "GET",
    "-f", `since=${since.toISOString()}`,
    "--jq", "[.[] | {body, created_at}]",
  );
  if (code !== 0) return false;
  try {
    return stopRequested(JSON.parse(stdout || "[]") as StopComment[], since);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      "stop-file": { type: "string" },
      since: { type: "string" },
      "interval-seconds": { type: "string" },
    },
  });

  if (!values.number || !values["stop-file"] || !values.since) {
    console.error("usage: watch_for_stop.ts --number N --stop-file PATH --since ISO8601");
    process.exit(2);
  }

  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const since = new Date(values.since);
  const intervalMs = (Number(values["interval-seconds"]) || DEFAULT_INTERVAL_SECONDS) * 1000;

  console.error(`Watching #${values.number} for a stop request since ${since.toISOString()}`);

  for (;;) {
    await Bun.sleep(intervalMs);
    if (!poll(repo, String(values.number), since)) continue;
    // Content, not an empty file: a person reading the run's directory afterwards
    // should find out why the run stopped without having to know what the path means.
    writeFileSync(values["stop-file"], `stop requested on #${values.number}\n`);
    console.error(`Stop request found; wrote ${values["stop-file"]}`);
    return;
  }
}

if (import.meta.main) await main();

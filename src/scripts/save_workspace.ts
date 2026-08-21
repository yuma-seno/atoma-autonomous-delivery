#!/usr/bin/env bun
/**
 * save_workspace.ts — persist the working files the agent left behind.
 *
 * Runs after the agent, and takes the root issue from the restore step's output
 * rather than resolving the chain again. Resolving twice invites the two answers
 * disagreeing -- a parent tag edited mid-run would have this write to a different
 * workspace than the one the agent read from, and nothing would say so.
 *
 * Usage:
 *   save_workspace.ts --root-issue N --source /tmp/atoma-workspace [--agent NAME]
 *
 * Best effort. A failure costs the next run its notes, and must not cost this run
 * its result -- the work is already committed and the report already posted by the
 * time this runs. It says so and exits 0.
 */
import { existsSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { saveWorkspace, workspaceTargetPrefix } from "./lib/atoma-data.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface SaveWorkspaceArgs {
  "root-issue": string | number;
  source: string;
  agent?: string;
}

export const ref = defineScript<SaveWorkspaceArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "root-issue": { type: "string" },
      source: { type: "string" },
      agent: { type: "string" },
    },
  });

  const root = values["root-issue"];
  const source = values.source;
  if (!root || !source) {
    console.error("usage: save_workspace.ts --root-issue N --source PATH [--agent NAME]");
    process.exit(2);
  }

  if (!existsSync(source)) {
    console.error(`[atoma-workspace] ${source} does not exist; nothing to save`);
    return;
  }

  // An empty workspace is still worth pushing: it is how a deletion takes effect.
  // The agent removing its notes and this skipping the save would leave them there
  // for the next run, which is the shape where deletions silently do not happen.
  const count = readdirSync(source).length;
  const prefix = workspaceTargetPrefix(root);
  const saved = saveWorkspace(
    prefix,
    source,
    `atoma: workspace for issue #${root}${values.agent ? ` (${values.agent})` : ""} — ${count} entries`,
  );

  console.error(
    saved
      ? `[atoma-workspace] saved ${count} entries to ${prefix}`
      : `[atoma-workspace] WARN could not save ${prefix}; the next run on this issue starts without these files`,
  );
}

if (import.meta.main) main();

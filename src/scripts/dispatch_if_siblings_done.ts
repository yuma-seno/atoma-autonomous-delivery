#!/usr/bin/env bun
/**
 * dispatch_if_siblings_done.ts — FALLBACK path for a manually-closed
 * sub-issue: if no open siblings remain, post a progress comment on the
 * parent and re-dispatch the orchestrator.
 *
 * Mirrors (but does not share code with) dispatch_orchestrator_if_ready.ts's
 * tail -- that script re-derives the parent from the closed sub-issue
 * itself and retries on eventual-consistency lag; this one already knows
 * the parent (from check_sub_issue_closure.ts) and, matching this fallback
 * path's original behavior, does not retry.
 *
 * Usage: dispatch_if_siblings_done.ts --repo OWNER/REPO --parent N
 */
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gh } from "./lib/gh.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export interface DispatchIfSiblingsDoneArgs {
  repo: string;
  parent: string | number;
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      parent: { type: "string" },
    },
  });
  if (!values.repo || !values.parent) {
    console.error("usage: dispatch_if_siblings_done.ts --repo OWNER/REPO --parent N");
    process.exit(2);
  }
  const { repo, parent } = values;

  console.log("Sub-issue closed manually. Checking open siblings...");
  const siblingsOut = Bun.spawnSync({
    cmd: ["bun", "run", join(SCRIPT_DIR, "check_open_siblings.ts"), "--repo", repo, "--parent", parent],
    stdout: "pipe",
    stderr: "inherit",
  });
  const siblingCount = Number(siblingsOut.stdout.toString("utf8").trim() || "0");

  if (siblingCount > 0) {
    console.log(`Still ${siblingCount} sibling(s) open. No action needed.`);
    return;
  }

  console.log(`All siblings done. Dispatching orchestrator on parent #${parent} ...`);
  // atoma-runner.yml only actually runs the agent when new_event_count !=
  // '0' (a hash comparison of the parent issue's own body+comments against
  // the orchestrator's last processed snapshot). Without a new comment on
  // the parent itself, the dispatched run would just no-op as "skipped" --
  // post one here first, same as aggregate_sub_issues.ts.
  gh("issue", "comment", parent, "--repo", repo, "--body", "All sub-tasks completed. Re-invoking orchestrator for aggregation.");

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

if (import.meta.main) main();

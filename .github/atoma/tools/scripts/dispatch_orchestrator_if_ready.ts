#!/usr/bin/env bun
/**
 * dispatch_orchestrator_if_ready.ts — After a sub-issue closes, check whether
 * all of its siblings (sharing the same <!-- atoma:parent=#N --> tag) are
 * also done, and if so, re-invoke the orchestrator on the parent issue for
 * aggregation.
 *
 * Standalone (not inlined in mcp/github.ts) so multiple close
 * paths can trigger the exact same phase-gating logic without duplicating it:
 *   - mcp/github.ts's closeIssue (the normal merge_pr-driven
 *     path and the origin-agent re-invocation confirmation path)
 *   - request_close_issue.ts (invoked by mcp/atoma.ts's
 *     request_close_issue tool, used by the orchestrator)
 *
 * Normally this decision is made by atoma-pr-merged.yml /
 * atoma-sub-issue-closed.yml, triggered by the pull_request_target/issues
 * GitHub events. But those events are NEVER delivered for actions taken with
 * the Actions GITHUB_TOKEN (this process's own `gh issue close` calls) --
 * GitHub explicitly suppresses event cascades from the default token to
 * prevent recursive workflow runs. So under merge_policy: "auto" neither
 * workflow ever fires, and the aggregation logic would silently never run.
 * `gh workflow run` (workflow_dispatch) is explicitly exempted from that
 * suppression, so replicate the sibling-check-and-dispatch here instead of
 * relying on the event-triggered workflows.
 *
 * Usage:
 *   dispatch_orchestrator_if_ready.ts --repo OWNER/REPO --issue N
 *
 * Best-effort: never throws, just logs progress to stderr and returns.
 */
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gh } from "./lib/gh.ts";
import type { GhIssueBody } from "./lib/types.ts";

/** CLI contract for this script, used by callers to build a type-checked argv. */
export interface DispatchOrchestratorIfReadyArgs {
  repo: string;
  issue: string | number;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function log(msg: string): void {
  console.error(`[dispatch-orchestrator-if-ready] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      issue: { type: "string" },
    },
  });

  if (!values.repo || !values.issue) {
    console.error("usage: dispatch_orchestrator_if_ready.ts --repo OWNER/REPO --issue N");
    process.exit(2);
  }
  const repo = values.repo;
  const subIssueNum = values.issue;

  const { code, stdout } = gh("issue", "view", subIssueNum, "--repo", repo, "--json", "body");
  const d = code === 0 && stdout ? (JSON.parse(stdout) as GhIssueBody) : {};
  const body = d.body ?? "";
  const m = /<!--\s*atoma:parent=#(\d+)\s*-->/.exec(body);
  if (!m) {
    log(`issue #${subIssueNum} has no atoma:parent tag, nothing to do`);
    return;
  }
  const parentNum = m[1]!;

  // gh issue list --search relies on GitHub's search index, which is only
  // eventually consistent -- the issue we just closed a moment ago may still
  // be reported as open for a second or two. Retry a few times with a short
  // backoff before trusting a non-zero count, otherwise this races and
  // under-counts correctly-closed siblings as still open, silently skipping
  // dispatch.
  let siblingCount: number | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    const countOut = Bun.spawnSync({
      cmd: ["bun", "run", join(SCRIPT_DIR, "check_open_siblings.ts"), "--repo", repo, "--parent", parentNum],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (countOut.exitCode !== 0) {
      log(`check_open_siblings failed: ${countOut.stderr.toString("utf8").trim()}`);
      return;
    }
    const raw = countOut.stdout.toString("utf8").trim();
    siblingCount = Number(raw || "0");
    if (Number.isNaN(siblingCount)) {
      log(`unexpected sibling count output: ${JSON.stringify(raw)}`);
      return;
    }
    if (siblingCount === 0) break;
    log(`attempt ${attempt + 1}: ${siblingCount} sibling(s) of #${parentNum} still open (may be search-index lag), retrying`);
  }
  if (siblingCount) {
    log(`${siblingCount} sibling(s) of #${parentNum} still open after retries, not dispatching`);
    return;
  }

  // atoma-runner.yml only actually runs the agent when new_event_count != '0'
  // (build_context_session.py's change-detection gate). A bare `gh workflow
  // run` with nothing new posted on the parent issue itself would dispatch a
  // run that immediately no-ops as "skipped" -- confirmed empirically. Post a
  // visible completion comment first so the orchestrator's next invocation
  // sees a genuinely new event.
  {
    const { code: rc, stdout: out, stderr: err } = gh(
      "issue", "comment", parentNum, "--repo", repo,
      "--body", `All sub-tasks completed (last: #${subIssueNum}). Re-invoking orchestrator for aggregation.`,
    );
    if (rc) log(`could not post trigger comment on #${parentNum}: ${err || out}`);
  }

  const notifyOut = Bun.spawnSync({
    cmd: ["bun", "run", join(SCRIPT_DIR, "resolve_notify.ts"), "--repo", repo, "--number", parentNum],
    stdout: "pipe",
    stderr: "pipe",
  });
  const notify = notifyOut.stdout.toString("utf8").trim();
  log(`all siblings of #${parentNum} done, dispatching orchestrator`);
  const { code: rc2, stdout: out2, stderr: err2 } = gh(
    "workflow", "run", "atoma-runner.yml",
    "--repo", repo,
    "--field", "agent=orchestrator",
    "--field", `number=${parentNum}`,
    "--field", "type=issue",
    "--field", `notify=${notify}`,
  );
  if (rc2) log(`gh workflow run failed (rc=${rc2}): ${err2 || out2}`);
}

if (import.meta.main) void main();

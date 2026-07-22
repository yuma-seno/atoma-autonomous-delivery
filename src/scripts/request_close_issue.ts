#!/usr/bin/env bun
/**
 * request_close_issue.ts
 *
 * Called by mcp/atoma.ts when the orchestrator uses
 * request_close_issue to conclude work on its CURRENT issue.
 *
 * Decides how to conclude based on who opened THIS issue -- a directly
 * observable GitHub API fact, not something the LLM needs to recall about its
 * own invocation history:
 *   - Bot-authored (a sub-issue created by another Atoma agent) -> close it
 *     directly, then trigger the same phase-gating/aggregation dispatch used
 *     by the normal merge_pr-driven close path.
 *   - Human-authored (a root issue opened directly by a person) -> never
 *     auto-close; instead post a comment mentioning them with the reason and
 *     summary, asking them to review and close it themselves.
 *
 * Usage: request_close_issue.ts --issue N --reason TEXT [--summary TEXT]
 */
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gh } from "./lib/gh.ts";
import type { GhIssueAuthor } from "./lib/types.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** CLI contract for this script, used by callers to build a type-checked argv. */
export interface RequestCloseIssueArgs {
  issue: string | number;
  reason: string;
  summary?: string;
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      reason: { type: "string" },
      summary: { type: "string" },
    },
  });

  const issue = values.issue ?? "";
  const reason = values.reason ?? "";
  const summary = values.summary ?? "";

  if (!issue) {
    console.error("Error: --issue is required");
    process.exit(1);
  }
  if (!reason) {
    console.error("Error: --reason is required");
    process.exit(1);
  }
  if (!/^\d+$/.test(issue)) {
    console.error(`Error: --issue must be a positive integer, got: ${issue}`);
    process.exit(1);
  }

  const repo = process.env.GITHUB_REPOSITORY ?? "";

  // NOTE: `gh issue view --json author` returns {id, is_bot, login, name} --
  // there is NO `.type` field (that only exists on the REST
  // `gh api .../issues/N` endpoint, as `.user.type`). Use the reliable
  // `.author.is_bot` boolean instead.
  const { stdout } = gh("issue", "view", issue, "--repo", repo, "--json", "author");
  const authorInfo = stdout ? (JSON.parse(stdout) as GhIssueAuthor) : {};
  const isBot = authorInfo.author?.is_bot ?? false;

  let body = `Atoma: orchestrator considers work on this issue complete.\n\n**Reason:** ${reason}`;
  if (summary) {
    body += `\n\n${summary}`;
  }

  if (!isBot) {
    const notifyOut = Bun.spawnSync({
      cmd: ["bun", "run", join(SCRIPT_DIR, "resolve_notify.ts"), "--repo", repo, "--number", issue],
      stdout: "pipe",
    });
    const notify = notifyOut.stdout.toString("utf8").trim();
    const mention = notify ? `@${notify} ` : "";
    body = `${mention}${body}\n\nThis issue was opened directly by a human, so it will not be closed automatically. Please review and close it yourself if you agree, or comment with further instructions.`;
    gh("issue", "comment", issue, "--repo", repo, "--body", body);
    console.log(`escalated: issue=#${issue} (human-authored, not closed)`);
  } else {
    gh("issue", "comment", issue, "--repo", repo, "--body", body);
    gh("issue", "close", issue, "--repo", repo);
    console.log(`closed: issue=#${issue} (bot-authored)`);
    Bun.spawnSync({
      cmd: ["bun", "run", join(SCRIPT_DIR, "dispatch_orchestrator_if_ready.ts"), "--repo", repo, "--issue", issue],
      stdout: "inherit",
      stderr: "inherit",
    });
  }
}

if (import.meta.main) main();

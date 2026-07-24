#!/usr/bin/env bun
/**
 * request_close_issue.ts
 *
 * Exports `concludeIssue()`, called directly (no more subprocess spawn) by
 * mcp/atoma.ts's request_close_issue tool handler. The `main()` CLI
 * wrapper below is kept for manual invocation/debugging.
 *
 * CRITICAL: `concludeIssue()` (and anything it calls) must NEVER use
 * `console.log()` -- only `console.error()`. It now runs IN-PROCESS inside
 * the `atoma-mcp-server` MCP server, whose `process.stdout` IS the JSON-RPC
 * stdio transport stream (see @modelcontextprotocol/sdk's
 * StdioServerTransport); a stray `console.log()` here writes a non-JSON-RPC
 * line into that same stream and corrupts the protocol, breaking the tool
 * call for the real `atoma` client with an opaque "Failed to call tool"
 * error (caught once already during this refactor -- see git history).
 * This did NOT matter before this refactor, when this script ran as its
 * own separate subprocess with its own independent stdout.
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
import { gh } from "../../../lib/gh.ts";
import { resolveNotify } from "../../../lib/notify.ts";
import { dispatchOrchestratorIfSubIssueReady } from "../../../lib/aggregation.ts";
import type { GhIssueAuthor } from "../../../lib/types.ts";

/** CLI contract for this script, used by callers to build a type-checked argv. */
export interface RequestCloseIssueArgs {
  issue: string | number;
  reason: string;
  summary?: string;
}

export interface ConcludeIssueResult {
  /** "closed" for a bot-authored sub-issue (closed directly); "escalated" for a human-authored root issue (left open, human mentioned). */
  outcome: "closed" | "escalated";
}

/**
 * Concludes work on `issue` per the reason/summary given, deciding whether
 * to close it directly or escalate to a human based on who opened it.
 */
export async function concludeIssue(issue: number, reason: string, summary: string): Promise<ConcludeIssueResult> {
  const repo = process.env.GITHUB_REPOSITORY ?? "";

  // NOTE: `gh issue view --json author` returns {id, is_bot, login, name} --
  // there is NO `.type` field (that only exists on the REST
  // `gh api .../issues/N` endpoint, as `.user.type`). Use the reliable
  // `.author.is_bot` boolean instead.
  const { stdout } = gh("issue", "view", String(issue), "--repo", repo, "--json", "author");
  const authorInfo = stdout ? (JSON.parse(stdout) as GhIssueAuthor) : {};
  const isBot = authorInfo.author?.is_bot ?? false;

  let body = `Atoma: orchestrator considers work on this issue complete.\n\n**Reason:** ${reason}`;
  if (summary) {
    body += `\n\n${summary}`;
  }

  if (!isBot) {
    const notify = resolveNotify(repo, issue);
    const mention = notify ? `@${notify} ` : "";
    body = `${mention}${body}\n\nThis issue was opened directly by a human, so it will not be closed automatically. Please review and close it yourself if you agree, or comment with further instructions.`;
    gh("issue", "comment", String(issue), "--repo", repo, "--body", body);
    console.error(`escalated: issue=#${issue} (human-authored, not closed)`);
    return { outcome: "escalated" };
  }

  gh("issue", "comment", String(issue), "--repo", repo, "--body", body);
  gh("issue", "close", String(issue), "--repo", repo);
  console.error(`closed: issue=#${issue} (bot-authored)`);
  await dispatchOrchestratorIfSubIssueReady(repo, issue);
  return { outcome: "closed" };
}

async function main(): Promise<void> {
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

  await concludeIssue(Number(issue), reason, summary);
}

if (import.meta.main) void main();


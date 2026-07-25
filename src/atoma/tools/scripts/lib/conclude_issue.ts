import { gh } from "../../../../lib/gh.ts";
import { resolveNotify } from "../../../../lib/notify.ts";
import { dispatchOrchestratorIfSubIssueReady } from "../../../../lib/aggregation.ts";
import type { GhIssueAuthor } from "../../../../lib/types.ts";

export interface ConcludeIssueResult {
  outcome: "closed" | "escalated";
}

/**
 * Closes bot-authored sub-issues directly and asks a human to review
 * human-authored root issues.
 */
export async function concludeIssue(issue: number, reason: string, summary: string): Promise<ConcludeIssueResult> {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
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
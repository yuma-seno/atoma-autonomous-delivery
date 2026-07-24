/**
 * inject-sub-results.ts — Replace the last tool message in a session with
 * aggregated sub-issue completion results, so the orchestrator sees a
 * summary of what happened when it's re-invoked for final aggregation.
 * The one canonical implementation (was inject_sub_results.ts), called
 * directly by aggregate_sub_issues.ts -- no more subprocess spawn.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gh } from "./gh.ts";
import type { GhPrSummary } from "./types.ts";
import type { Session, SessionMessage } from "./session.ts";

export type { Session, SessionMessage };

function findLastToolIndex(messages: SessionMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "tool") return i;
  }
  return null;
}

function gatherSubResults(repo: string, subIssues: number[]): string {
  const lines: string[] = ["All sub-issues have been completed.", "", "## Sub-issue Results", ""];

  for (const num of subIssues) {
    let title = "Unknown";
    let state = "closed";

    try {
      const { code, stdout } = gh("issue", "view", String(num), "--repo", repo, "--json", "title,state,closedAt");
      if (code === 0 && stdout) {
        const info = JSON.parse(stdout) as { title?: string; state?: string };
        title = info.title ?? "Unknown";
        state = info.state ?? "closed";
      }
    } catch {
      // keep defaults
    }

    const linkedPrs: string[] = [];
    for (const state_ of ["merged", "open"] as const) {
      try {
        const { code, stdout } = gh("pr", "list", "--repo", repo, "--state", state_, "--search", `#${num} in:body`, "--json", "number,title,url");
        if (code === 0 && stdout) {
          const prs = JSON.parse(stdout) as GhPrSummary[];
          for (const pr of prs) {
            linkedPrs.push(`- PR #${pr.number}: ${pr.title} (${pr.url})`);
          }
        }
      } catch {
        // best-effort
      }
    }

    lines.push(`### #${num}: ${title}`);
    lines.push(`Status: ${state}`);
    if (linkedPrs.length) {
      lines.push("Linked PRs:");
      lines.push(...linkedPrs);
    } else {
      lines.push("No linked PRs found.");
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("All sub-issues are complete. Please review the results and aggregate them into a final summary.");
  return lines.join("\n");
}

/** Pure transform: returns an updated copy-in-place `session` with the last tool message replaced (or a new user message appended if none exists). */
export function injectSubResults(session: Session, repo: string, subIssues: number[]): Session {
  const messages = session.messages ?? [];
  const lastToolIdx = findLastToolIndex(messages);
  const summary = gatherSubResults(repo, subIssues);

  if (lastToolIdx === null) {
    console.error("No tool message found in session. Appending as user message.");
    messages.push({ role: "user", content: summary });
  } else {
    messages[lastToolIdx]!.content = summary;
  }

  session.messages = messages;
  return session;
}

/** File-based convenience wrapper matching the original CLI script's contract. */
export function injectSubResultsFile(sessionPath: string, repo: string, subIssues: number[], outPath: string): void {
  const session = JSON.parse(readFileSync(sessionPath, "utf8")) as Session;
  const updated = injectSubResults(session, repo, subIssues);
  writeFileSync(outPath, JSON.stringify(updated, null, 2));
}

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
    // Not "closed". This block feeds the orchestrator's final report, whose whole
    // job is to state what happened, and a sub-issue whose state could not be
    // read is exactly the one thing that report must not assert. One rate-limited
    // lookup used to turn into "Status: closed" for work still in progress.
    let state = "could not be read";

    try {
      const { code, stdout } = gh("issue", "view", String(num), "--repo", repo, "--json", "title,state,closedAt");
      if (code === 0 && stdout) {
        const info = JSON.parse(stdout) as { title?: string; state?: string };
        title = info.title ?? "Unknown";
        state = info.state ?? "could not be read";
      }
    } catch {
      // keep defaults
    }

    const linkedPrs: string[] = [];
    // Tracked separately from an empty result, because "none found" and "could
    // not look" read identically once they reach the report and only one of them
    // is a fact.
    let prLookupFailed = false;
    for (const state_ of ["merged", "open"] as const) {
      try {
        const { code, stdout } = gh("pr", "list", "--repo", repo, "--state", state_, "--search", `#${num} in:body`, "--json", "number,title,url");
        if (code === 0 && stdout) {
          const prs = JSON.parse(stdout) as GhPrSummary[];
          for (const pr of prs) {
            linkedPrs.push(`- PR #${pr.number}: ${pr.title} (${pr.url})`);
          }
        } else {
          prLookupFailed = true;
        }
      } catch {
        prLookupFailed = true;
      }
    }

    lines.push(`### #${num}: ${title}`);
    lines.push(`Status: ${state}`);
    if (linkedPrs.length) {
      lines.push("Linked PRs:");
      lines.push(...linkedPrs);
    } else if (prLookupFailed) {
      lines.push("Linked PRs could not be read.");
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

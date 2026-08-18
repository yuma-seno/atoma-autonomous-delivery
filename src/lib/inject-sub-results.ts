/**
 * inject-sub-results.ts — Replace the last tool message in a session with
 * aggregated sub-issue completion results, so the orchestrator sees a
 * summary of what happened when it's re-invoked for final aggregation.
 * The one canonical implementation (was inject_sub_results.ts), called
 * directly by aggregate_sub_issues.ts -- no more subprocess spawn.
 */
import { gh } from "./gh.ts";
import type { GhPrSummary } from "./types.ts";
import type { Session, SessionMessage } from "./session.ts";

// No `export type { Session, SessionMessage }` here.
//
// Eleven files import `Session` from `lib/session.ts`; exactly one used to get
// it through this re-export, which made a second route to the same type. See
// `config.ts`, which argues the same point about `getDeclaredSecrets`: the next
// caller finds whichever route it meets first, and then the two exist forever.

function findLastToolIndex(messages: SessionMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "tool") return i;
  }
  return null;
}

export function gatherSubResults(repo: string, subIssues: number[]): string {
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

/**
 * Put `summary` where the orchestrator will read it: over the last tool message,
 * or appended as a user message when the session has none.
 *
 * Takes the text rather than fetching it. The doc comment here used to say
 * "Pure transform: returns an updated copy-in-place" -- which is two claims and
 * both were wrong. It was not pure: it called `gatherSubResults`, up to three
 * `gh` calls per sub-issue. And it is not a copy: it mutates `session.messages`
 * in place and returns the same object, which "copy-in-place" says in one
 * self-contradictory breath.
 *
 * The cost was that this rule -- find the last tool message, replace it, append
 * when there is none -- could not be tested without a fake `gh` on PATH. It is a
 * decision about a data structure and now reads like one.
 */
export function injectSummary(session: Session, summary: string): Session {
  const messages = session.messages ?? [];
  const lastToolIdx = findLastToolIndex(messages);

  if (lastToolIdx === null) {
    console.error("No tool message found in session. Appending as user message.");
    messages.push({ role: "user", content: summary });
  } else {
    messages[lastToolIdx]!.content = summary;
  }

  session.messages = messages;
  return session;
}


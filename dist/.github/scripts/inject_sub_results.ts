#!/usr/bin/env bun
/**
 * inject_sub_results.ts — Replace the last tool message in a session JSON
 * with aggregated sub-issue completion results.
 *
 * Usage:
 *   bun run inject_sub_results.ts \
 *     --session session.json \
 *     --repo OWNER/REPO \
 *     --parent N \
 *     --sub-issues 2,3,4 \
 *     --out session.json
 *
 * Reads the session, finds the last `role: "tool"` message (the one left by
 * launch_sub_agent), and replaces its content with an aggregated result
 * summarizing the completed sub-issues and their linked PRs.
 */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { gh } from "./lib/gh.ts";
import type { GhPrSummary } from "./lib/types.ts";

/** CLI contract for this script, used by callers to build a type-checked argv. */
export interface InjectSubResultsArgs {
  session: string;
  repo: string;
  parent: string | number;
  "sub-issues": string;
  out: string;
}

interface SessionMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

interface Session {
  messages: SessionMessage[];
  [key: string]: unknown;
}

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
      const { code, stdout } = gh(
        "issue", "view", String(num),
        "--repo", repo,
        "--json", "title,state,closedAt",
      );
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
        const { code, stdout } = gh(
          "pr", "list",
          "--repo", repo,
          "--state", state_,
          "--search", `#${num} in:body`,
          "--json", "number,title,url",
        );
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

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      session: { type: "string" },
      repo: { type: "string" },
      parent: { type: "string" },
      "sub-issues": { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.session || !values.repo || !values.parent || !values["sub-issues"] || !values.out) {
    console.error(
      "usage: inject_sub_results.ts --session FILE --repo OWNER/REPO --parent N --sub-issues N,N,... --out FILE",
    );
    process.exit(2);
  }

  const subIssues = values["sub-issues"]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);

  const session = JSON.parse(readFileSync(values.session, "utf8")) as Session;
  const messages = session.messages ?? [];
  const lastToolIdx = findLastToolIndex(messages);

  const summary = gatherSubResults(values.repo, subIssues);
  if (lastToolIdx === null) {
    console.error("No tool message found in session. Appending as user message.");
    messages.push({ role: "user", content: summary });
  } else {
    messages[lastToolIdx]!.content = summary;
  }

  session.messages = messages;
  writeFileSync(values.out, JSON.stringify(session, null, 2));

  console.error(`Session updated: replaced tool message at index ${lastToolIdx}`);
  console.error(`Output written to ${values.out}`);
}

if (import.meta.main) main();

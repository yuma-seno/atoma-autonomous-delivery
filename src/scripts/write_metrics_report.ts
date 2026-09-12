#!/usr/bin/env bun
/**
 * write_metrics_report.ts — read every stored session and write the report a person reads.
 *
 * Runs at the end of an agent run, where the branch is already being written to and the
 * cost is a few seconds on a job that took minutes. See `domain/metrics.ts` for what is
 * counted and `domain/metrics-report.ts` for why it is Markdown on `atoma-data`.
 *
 * Usage:
 *   write_metrics_report.ts [--repo OWNER/REPO] [--stdout]
 *
 * `--stdout` prints the report instead of committing it, which is how to look at it
 * without touching the branch.
 *
 * ## Reading the sessions without a checkout
 *
 * `git show <ref>:<path>` per file, from the fetched ref. A worktree would put 25 MB on
 * disk to read files that are read once; and the current checkout at this point in a run
 * may hold the agent's own uncommitted work, which nothing here may disturb.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { ghPaginated, gitRun } from "../lib/gh.ts";
import { defineScript } from "./lib/script-ref.ts";
import { saveSession } from "./lib/atoma-data.ts";
import { classifyShellAct } from "../domain/search-streak.ts";
import { metricsOf, type CallRecord, type SessionRecord, type TokenRecord } from "../domain/metrics.ts";
import { type RunRecord } from "../domain/metrics-windows.ts";
import { renderReport } from "../domain/metrics-report.ts";

export const ref = defineScript(import.meta.url);

const BRANCH = "atoma-data";

/** Where the report lives. Beside the data it is read from, not in the deliverable. */
export const REPORT_PATH = "metrics/report.md";

/**
 * Where the same data lives unsummarised.
 *
 * One row per session, with its runs and its call tallies. The report shows the slices
 * somebody decided were worth a heading; this is for the slice nobody has thought of,
 * which is where every finding this repository has made about its own agents came from.
 * Answering a new question should be a query rather than a change to this file.
 */
export const ROWS_PATH = "metrics/rows.json";

/** The rows, in the shape a one-off script would want them. */
function rowsOf(sessions: readonly SessionRecord[]): unknown[] {
  return sessions.map((s) => {
    const tools: Record<string, number> = {};
    const acts: Record<string, number> = {};
    for (const call of s.calls) {
      tools[call.tool] = (tools[call.tool] ?? 0) + 1;
      if (call.act) acts[call.act] = (acts[call.act] ?? 0) + 1;
    }
    return {
      path: s.path,
      agent: s.agent,
      messages: s.messages,
      calls: s.calls.length,
      failed: s.calls.filter((c) => c.failed).length,
      refused: s.calls.filter((c) => c.refused).length,
      skills: s.calls.flatMap((c) => (c.skill ? [c.skill] : [])),
      tools,
      acts,
      runs: s.runs,
    };
  });
}

function log(message: string): void {
  console.error(`[metrics] ${message}`);
}

/**
 * The agent a session belongs to, from its path.
 *
 * Both layouts end in the agent's name: `issue-7-engineer.json` and
 * `issue-7/engineer.json`, with `archive/engineer-1.json` beside the second. Unreadable
 * is `unknown` rather than a guess, so a layout nobody anticipated shows up as a row in
 * the report instead of being silently attributed to the wrong agent.
 */
export function agentOf(path: string): string {
  const file = path.split("/").pop() ?? "";
  const stem = file.replace(/\.json$/, "").replace(/-\d+$/, "");
  const match = /(?:^|-)(orchestrator|engineer|reviewer)$/.exec(stem);
  return match?.[1] ?? "unknown";
}

/** Whether a tool result reads as a failure. A string match, and the report says so. */
function looksFailed(content: string): boolean {
  return /^\s*(Error|error):/.test(content) || /"status"\s*:\s*"(failed|error)"/.test(content);
}

/** Whether a result is a hook refusing the call rather than a tool answering it. */
function looksRefused(content: string): boolean {
  return /blocked by hook|shell_guard:|Tool blocked/.test(content);
}

function sessionFrom(path: string, raw: string): SessionRecord | undefined {
  let parsed: {
    messages?: { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown[] }[];
    atoma_runs?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    log(`${path} is not readable as JSON; skipping it`);
    return undefined;
  }
  const messages = parsed.messages ?? [];
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      results.set(message.tool_call_id, typeof message.content === "string" ? message.content : "");
    }
  }

  const calls: CallRecord[] = [];
  const agent = agentOf(path);
  for (const message of messages) {
    for (const call of (message.tool_calls ?? []) as { id?: string; function?: { name?: string; arguments?: string } }[]) {
      const tool = call.function?.name ?? "";
      if (!tool) continue;
      const result = results.get(call.id ?? "") ?? "";
      let skill: string | undefined;
      let act: CallRecord["act"];
      if (tool.endsWith("load_skill")) {
        try {
          skill = JSON.parse(call.function?.arguments ?? "{}").name;
        } catch {
          /* a malformed load_skill is counted as a call and named by no skill */
        }
      } else if (tool.endsWith("shell_execute")) {
        try {
          const command = JSON.parse(call.function?.arguments ?? "{}").command ?? "";
          act = shellAct(command);
        } catch {
          act = "other";
        }
      }
      calls.push({ tool, agent, failed: looksFailed(result), refused: looksRefused(result), skill, act });
    }
  }
  // `atoma_runs` is atoma's own, written from v0.1.28. Anything unreadable is no
  // runs rather than a failure: a session from before it is the normal case.
  const runs = Array.isArray((parsed as { atoma_runs?: unknown }).atoma_runs)
    ? ((parsed as { atoma_runs: RunRecord[] }).atoma_runs)
    : [];
  return { path, agent, messages: messages.length, calls, runs };
}

/**
 * What a shell command was doing.
 *
 * `classifyShellAct` already answers search/open/other for the search guard, and using
 * it here rather than a second classifier is the point: the report and the guard then
 * cannot disagree about what a search is. Editing and verifying are the two categories
 * the guard has no opinion about, so they are added on top.
 */
function shellAct(command: string): CallRecord["act"] {
  if (/>\s*[^\s|&>]+/.test(command) && !/>\s*\/dev\/null/.test(command)) return "edit";
  const head = command.trim().split(/\s*(?:\|\||&&|[;|])\s*/)[0] ?? "";
  const word = (head.trim().split(/\s+/).find((t) => t && !t.includes("=") && t !== "sudo" && t !== "time") ?? "")
    .split("/")
    .pop();
  if (word === "sed" && /\s-i\b/.test(command)) return "edit";
  if (/^(bun|npm|npx|pnpm|yarn|cargo|go|pytest|python3?|make|tsc|jest|vitest|mvn|gradle|dotnet)$/.test(word ?? "")) {
    return "verify";
  }
  const classified = classifyShellAct(command);
  return classified === "other" ? "other" : classified;
}

/** Every `_Tokens: N total (P prompt + C completion)_` line the agents have posted. */
function tokensReported(repo: string): TokenRecord[] {
  const comments = ghPaginated<{ body?: string; issue_url?: string }>(
    "api",
    `repos/${repo}/issues/comments?per_page=100`,
  );
  const out: TokenRecord[] = [];
  for (const comment of comments) {
    const match = /_Tokens:\s*([\d,]+)\s*total\s*\(([\d,]+)\s*prompt\s*\+\s*([\d,]+)\s*completion\)_/.exec(
      comment.body ?? "",
    );
    if (!match) continue;
    const number = Number(/(\d+)$/.exec(comment.issue_url ?? "")?.[1] ?? 0);
    const toNumber = (s: string) => Number(s.replace(/,/g, ""));
    out.push({
      issue: number,
      total: toNumber(match[1]!),
      prompt: toNumber(match[2]!),
      completion: toNumber(match[3]!),
    });
  }
  return out;
}

/** The tools and skills the repository offers, so the report can name what is unused. */
function declared(): { tools: string[]; skills: string[] } {
  const root = process.env.ATOMA_MACHINERY_ROOT?.trim() || ".";
  const tools: string[] = [];
  const skills: string[] = [];
  try {
    const yaml = readFileSync(`${root}/.github/atoma/tools/tools.yaml`, "utf8");
    for (const line of yaml.split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
      // `hooks` is the reserved key at this level, not a server.
      if (match?.[1] && match[1] !== "hooks") tools.push(match[1]);
    }
  } catch {
    log("could not read tools.yaml; the report will not name unused tools");
  }
  const listed = gitRun("ls-files", `${root}/.github/atoma/skills`);
  for (const path of listed.stdout.split("\n")) {
    const match = /skills\/(.+)\.md$/.exec(path.trim());
    if (match?.[1]) skills.push(match[1]);
  }
  return { tools, skills };
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { repo: { type: "string" }, stdout: { type: "boolean" } },
  });
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";

  if (gitRun("fetch", "origin", BRANCH).code !== 0) {
    log(`${BRANCH} does not exist yet; nothing to report on`);
    return;
  }
  const listed = gitRun("ls-tree", "-r", "--name-only", `origin/${BRANCH}`, "--", "sessions");
  const paths = listed.stdout.split("\n").map((s) => s.trim()).filter((s) => s.endsWith(".json"));

  const sessions: SessionRecord[] = [];
  for (const path of paths) {
    const shown = gitRun("show", `origin/${BRANCH}:${path}`);
    if (shown.code !== 0) continue;
    const record = sessionFrom(path, shown.stdout);
    if (record) sessions.push(record);
  }

  let tokens: TokenRecord[] = [];
  if (repo) {
    try {
      tokens = tokensReported(repo);
    } catch (error) {
      // The sessions are the report; the tokens are one section of it. A rate limit
      // should cost that section, not the whole thing.
      log(`could not read the reported tokens: ${(error as Error).message}`);
    }
  }

  const { tools, skills } = declared();
  const now = new Date();
  const report = renderReport(metricsOf(sessions, tools, skills, tokens), now);
  const runs = sessions.flatMap((s) => s.runs);
  log(`${sessions.length} sessions, ${runs.length} recorded runs, ${tokens.length} reporting tokens`);

  if (values.stdout) {
    console.log(report);
    return;
  }
  // Beside the report, and the reason it exists: the report answers the questions it
  // was built for, and this answers the ones nobody has asked yet. Every finding this
  // repository has made about its own agents came from a question of the second kind.
  if (!saveSession(ROWS_PATH, `${JSON.stringify(rowsOf(sessions), null, 2)}\n`, `atoma: metric rows from ${sessions.length} sessions`)) {
    log("could not write the rows; the report is unaffected");
  }
  if (!saveSession(REPORT_PATH, report, `atoma: metrics from ${sessions.length} sessions`)) {
    log("could not write the report; the run is unaffected");
  }
}

if (import.meta.main) main();

#!/usr/bin/env bun
/**
 * report_run_failure.ts — Post the comment a failed run leaves behind.
 *
 * ## Why this is a script and not workflow bash
 *
 * It used to be a dozen `echo` lines building markdown inside a TypeScript
 * template literal that generates YAML that becomes bash. Every backtick in that
 * text crosses three layers of escaping, and the text now needs backticks: the
 * two things a person can do next are slash commands, and a slash command written
 * as plain prose reads as prose. Every other human-facing comment in this
 * repository is built here, tested here, and invoked in one line.
 *
 * ## What changed about what it says
 *
 * **The session now survives a failure** (atoma#18). Anyone who has used Atoma
 * before will assume the opposite, so the notice says it outright and gives the
 * two ways forward — continue with the history, or archive it and start clean.
 * Which of those is right is a judgement about the work, and it belongs to the
 * person rather than to the machinery.
 *
 * ## Why the excerpt is last
 *
 * It is usually about the infrastructure — "MCP server closed connection",
 * "Unexpected while resolving package" — which no agent and often no person can
 * act on. It is kept because occasionally it is the answer, and put below the
 * part that always matters.
 *
 * Redacted before it becomes a comment: the log holds every MCP server's stderr,
 * and `unauthorized` is exactly the line a provider emits WITH the credential in
 * it. Actions masks registered secrets in the workflow log and does nothing for
 * an issue comment.
 *
 * Usage:
 *   report_run_failure.ts --number N --agent NAME [--notify LOGIN]
 *     --run-url URL [--logs-file FILE]
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gh } from "../lib/gh.ts";
import { redact } from "../domain/redaction.ts";
import { LLM_CONTEXT_TAG } from "../lib/tags.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface ReportRunFailureArgs {
  number: string | number;
  agent: string;
  notify?: string;
  "run-url": string;
  "logs-file"?: string;
}

export const ref = defineScript<ReportRunFailureArgs>(import.meta.url);

/** Lines from the run's log that might say what went wrong. */
const INTERESTING = /error|fail|panic|exception|unauthorized/i;
const EXCERPT_LINES = 5;

/**
 * The excerpt, redacted, or nothing.
 *
 * Silent on every failure. The notice is the thing that has to go out; an excerpt
 * is an improvement to it, not a precondition for it.
 */
export function logExcerpt(text: string): string {
  return text
    .split("\n")
    .filter((line) => INTERESTING.test(line))
    .slice(0, EXCERPT_LINES)
    .map((line) => redact(line))
    .join("\n")
    .trim();
}

/** The comment, as the person watching the issue will read it. */
export function failureNotice(
  agent: string,
  notify: string | undefined,
  runUrl: string,
  excerpt: string,
): string {
  const mention = notify ? `@${notify} ` : "";
  const lines = [
    LLM_CONTEXT_TAG.write("exclude"),
    `${mention}Atoma: \`${agent}\` did not finish — the run failed.`,
    "",
    "**The session was saved.** What this run worked out is still there.",
    "",
    `- Continue: comment \`/${agent}\` and put what to do next on the following lines.`,
    `- Start clean: comment \`/${agent} recover\`, which archives this session and rebuilds`,
    "  it from the issue.",
    "",
    `Workflow logs: ${runUrl}`,
  ];
  if (excerpt) {
    lines.push("", "From the log, which is often about the infrastructure rather than the work:", "```", excerpt, "```");
  }
  return lines.join("\n");
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      agent: { type: "string" },
      notify: { type: "string" },
      "run-url": { type: "string" },
      "logs-file": { type: "string" },
    },
  });

  if (!values.number) {
    // Not an error: a run can fail before the number is known, and there is
    // nowhere to post. Said in the workflow log, where somebody is already looking.
    console.error("::error::Cannot post failure comment: issue/PR number unknown.");
    return;
  }

  let excerpt = "";
  const logs = values["logs-file"];
  if (logs && existsSync(logs)) {
    try {
      excerpt = logExcerpt(readFileSync(logs, "utf8"));
    } catch {
      excerpt = "";
    }
  }

  const body = failureNotice(values.agent ?? "", values.notify, values["run-url"] ?? "", excerpt);
  const { code, stdout, stderr } = gh("issue", "comment", String(values.number), "--body", body);
  if (code !== 0) console.error(`Failed to post the failure comment: ${stderr || stdout}`);
}

if (import.meta.main) main();

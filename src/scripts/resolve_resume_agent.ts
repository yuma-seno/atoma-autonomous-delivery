#!/usr/bin/env bun
/**
 * resolve_resume_agent.ts — Decide which agent `/resume` means.
 *
 * `/resume` is `/<agent>` with the name filled in from what actually ran here, so a
 * person who wants to continue does not have to remember whether it was the engineer
 * or the reviewer. That is the only thing it does differently, which is why it takes
 * no instruction: `/<agent>` already resumes the same session AND carries one.
 *
 * The name is read from the thread rather than stored anywhere, the same choice
 * `dispatch-chain.ts` makes about handoffs. Every result comment already carries
 * `AGENT_TAG` -- `post_result_comment.ts` writes it so a later run can recognise its
 * own past output -- so the most recent one is the answer, and there is nothing extra
 * to keep in sync.
 *
 * Writes `agent` to $GITHUB_OUTPUT, empty when there is nothing to resume.
 *
 * Usage:
 *   resolve_resume_agent.ts --number N
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gh } from "../lib/gh.ts";
import { AGENT_TAG, LLM_CONTEXT_TAG } from "../lib/tags.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface ResolveResumeAgentArgs {
  number: string | number;
}

export const ref = defineScript<ResolveResumeAgentArgs>(import.meta.url);

/**
 * The agent named by the most recent comment that names one.
 *
 * Newest first, because an issue worked by an orchestrator and then an engineer must
 * resume the engineer. Taking the first match in chronological order would resume
 * whoever went first, every time, for the whole life of the issue.
 */
export function mostRecentAgent(bodies: string[]): string {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const agent = AGENT_TAG.read(bodies[i] ?? "");
    if (agent) return agent;
  }
  return "";
}

function main(): void {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { number: { type: "string" } } });
  if (!values.number) {
    console.error("usage: resolve_resume_agent.ts --number N");
    process.exit(2);
  }

  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const { code, stdout, stderr } = gh(
    "api", `repos/${repo}/issues/${values.number}/comments`, "--paginate", "--jq", "[.[].body]",
  );

  let agent = "";
  if (code === 0) {
    try {
      agent = mostRecentAgent(JSON.parse(stdout || "[]") as string[]);
    } catch {
      agent = "";
    }
  } else {
    console.error(`Could not read comments on #${values.number}: ${stderr || stdout}`);
  }

  if (!agent) {
    // Said on the issue, not only in the log. `/resume` produces no run when it
    // resolves to nothing, and a command that silently does nothing is
    // indistinguishable from a broken workflow.
    gh(
      "issue", "comment", String(values.number), "--repo", repo,
      "--body",
      [
        LLM_CONTEXT_TAG.write("exclude"),
        "Atoma: `/resume` found no previous run on this issue to continue. Use `/<agent>` to start one.",
      ].join("\n"),
    );
  }

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `agent=${agent}\n`);
  console.error(agent ? `Resuming ${agent}` : "Nothing to resume");
}

if (import.meta.main) main();

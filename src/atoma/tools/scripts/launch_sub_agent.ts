#!/usr/bin/env bun
/**
 * launch_sub_agent.ts
 *
 * Directly dispatches an Atoma agent on a sub-issue via gh workflow run.
 * Exports `dispatchSubAgent()`, called directly (no more subprocess spawn)
 * by mcp/atoma.ts's launch_sub_agent tool handler, once per task. The
 * `main()` CLI wrapper below is kept for manual invocation/debugging.
 *
 * CRITICAL: `dispatchSubAgent()` (and anything it calls) must NEVER use
 * `console.log()` -- only `console.error()`. It now runs IN-PROCESS inside
 * the `atoma-mcp-server` MCP server, whose `process.stdout` IS the JSON-RPC
 * stdio transport stream -- a stray `console.log()` here corrupts that
 * stream and breaks the tool call for the real `atoma` client (caught once
 * already during this refactor, in request_close_issue.ts -- see git
 * history for the full explanation). `main()` below is exempt: it only
 * runs standalone (never in-process with an MCP server).
 *
 * Usage: launch_sub_agent.ts --issue N --agent AGENT_NAME
 */
import { parseArgs } from "node:util";
import { gh } from "../../../lib/gh.ts";
import { getLabel } from "../../../lib/config.ts";
import { logDispatch } from "../../../lib/ops-log.ts";
import { LLM_CONTEXT_TAG } from "../../../lib/tags.ts";

/** CLI contract for this script, used by callers to build a type-checked argv. */
export interface LaunchSubAgentArgs {
  issue: string | number;
  agent: string;
}

export interface DispatchSubAgentResult {
  issue: number;
  agent: string;
}

/**
 * Posts a dispatch-confirmation comment on the sub-issue, tags it as
 * "launched" (so aggregation gating only waits on sub-issues that have
 * actually been dispatched, not ones still pending a later phase -- see
 * docs/agent-definition.md dependency handling), and dispatches the runner
 * workflow. Throws on invalid input; best-effort (logs a warning, does not
 * throw) on a failed label add.
 */
export function dispatchSubAgent(issue: number, agent: string, notify = ""): DispatchSubAgentResult {
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error(`issue must be a positive integer, got: ${issue}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) {
    throw new Error(`agent must be a valid lowercase agent name, got: ${agent}`);
  }

  console.error(`Dispatching agent '${agent}' on sub-issue #${issue} ...`);

  gh(
    "issue", "comment", String(issue),
    "--body", `${LLM_CONTEXT_TAG.write("exclude")}\nAtoma: Agent \`${agent}\` dispatched to work on this sub-task.`,
  );

  const launchedLabel = getLabel("launched", "atoma/launched");
  const { code: labelCode } = gh("issue", "edit", String(issue), "--add-label", launchedLabel);
  if (labelCode !== 0) {
    console.error(`Warning: failed to add '${launchedLabel}' label to #${issue}`);
  }

  const dispatchWorkflow = process.env.ATOMA_DISPATCH_WORKFLOW || "atoma-runner.yml";
  gh(
    "workflow", "run", dispatchWorkflow,
    "--field", `agent=${agent}`,
    "--field", `number=${issue}`,
    "--field", "type=issue",
    "--field", `notify=${notify}`,
  );
  logDispatch("issue", agent, { number: issue });

  return { issue, agent };
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      agent: { type: "string" },
    },
  });

  if (!values.issue) {
    console.error("Error: --issue is required");
    process.exit(1);
  }
  if (!values.agent) {
    console.error("Error: --agent is required");
    process.exit(1);
  }
  if (!/^\d+$/.test(values.issue)) {
    console.error(`Error: --issue must be a positive integer, got: ${values.issue}`);
    process.exit(1);
  }

  try {
    const result = dispatchSubAgent(Number(values.issue), values.agent, process.env.ISSUE_NOTIFY ?? "");
    console.log(`dispatched: agent=${result.agent} issue=#${result.issue}`);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) main();


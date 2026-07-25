#!/usr/bin/env bun
/**
 * atoma.ts — MCP server exposing Atoma orchestration tools.
 *
 * Transport: stdio, via the official @modelcontextprotocol/sdk.
 *
 * Tools:
 *   - launch_sub_agent: Launch Atoma agents on sub-issues and end the
 *     orchestrator session.
 *   - request_close_issue: Conclude work on the current issue.
 *
 * Both tool responses include `_meta.session_ends: true` so the Atoma core
 * can detect that the session should terminate.
 *
 * IMPORTANT: this process's `process.stdout` IS the JSON-RPC transport --
 * never `console.log()` anywhere in this file or in anything it calls
 * in-process (dispatchSubAgent/concludeIssue and whatever they import);
 * always `console.error()` (stderr) for logging. See
 * launch_sub_agent.ts/request_close_issue.ts's own doc comments for the
 * real incident this guards against.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { gh } from "../../../../lib/gh.ts";
import { dispatchSubAgent } from "../launch_sub_agent.ts";
import { LLM_CONTEXT_TAG } from "../../../../lib/tags.ts";
import { concludeIssue } from "../request_close_issue.ts";
import { buildMcpTools, defineMcpTool, z, type McpToolResult } from "../../../../lib/mcp-tool.ts";

function log(msg: string): void {
  console.error(`[atoma-mcp] ${msg}`);
}

const LAUNCH_SUB_AGENT_SCHEMA = z.object({
  tasks: z
    .array(
      z.object({
        issue: z.number().int().positive().describe("The sub-issue number."),
        agent: z.string().min(1).describe("The agent to dispatch (e.g., 'engineer')."),
      }),
    )
    .min(1, "tasks must be a non-empty list of {issue, agent} objects")
    .describe("List of {issue, agent} pairs to dispatch."),
});

const REQUEST_CLOSE_ISSUE_SCHEMA = z.object({
  reason: z.string().min(1).describe("Why this issue's work is considered complete."),
  summary: z.string().optional().describe("Final summary to include in the posted comment (e.g. an aggregation report)."),
});

function mcpFail(message: string): never {
  throw new Error(message);
}

function handleLaunchSubAgent(args: z.infer<typeof LAUNCH_SUB_AGENT_SCHEMA>): McpToolResult {
  const validTasks = args.tasks;

  log(`Dispatching ${validTasks.length} sub-issue(s): ${JSON.stringify(validTasks)}`);

  // The orchestrator's OWN current issue (the parent, from the sub-issues'
  // point of view).
  const parentIssue = (process.env.ISSUE_NUMBER ?? "").trim();
  const notify = process.env.ISSUE_NOTIFY ?? "";

  const dispatched: string[] = [];
  const errors: string[] = [];

  for (const { issue, agent } of validTasks) {
    try {
      dispatchSubAgent(issue, agent, notify);
      dispatched.push(`#${issue}→${agent}`);
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      log(`dispatchSubAgent failed for #${issue}: ${message}`);
      errors.push(`#${issue}/${agent}: ${message}`);
    }
  }

  // Best-effort comment on the PARENT issue so a human reading the parent's
  // thread has a full audit trail of what was dispatched.
  if (dispatched.length && parentIssue) {
    const bodyLines = [LLM_CONTEXT_TAG.write("exclude"), "Atoma: Launched sub-agent(s):", ...dispatched.map((d) => `- ${d}`)];
    gh("issue", "comment", parentIssue, "--body", bodyLines.join("\n"));
  }

  if (errors.length && !dispatched.length) {
    mcpFail(`All dispatches failed: ${errors.join("; ")}`);
  }

  const summaryLines = [`Dispatch comments posted for ${dispatched.length} sub-issue(s): ${dispatched.join(", ")}.`];
  if (errors.length) summaryLines.push(`Warning: ${errors.length} failed: ${errors.join("; ")}`);
  summaryLines.push("");
  summaryLines.push("Agents will be dispatched automatically. The orchestrator session will now end.");
  summaryLines.push("It will resume automatically when all sub-issues are closed.");

  return { text: summaryLines.join("\n"), meta: { session_ends: true } };
}

async function handleRequestCloseIssue(args: z.infer<typeof REQUEST_CLOSE_ISSUE_SCHEMA>): Promise<McpToolResult> {
  const reason = args.reason.trim();
  const summary = (args.summary ?? "").trim();

  if (!reason) mcpFail("reason must be a non-empty string");

  const issueNumberRaw = (process.env.ISSUE_NUMBER ?? "").trim();
  if (!issueNumberRaw) mcpFail("ISSUE_NUMBER is not set in the environment");
  const issueNumber = Number(issueNumberRaw);

  log(`Concluding issue #${issueNumber}: reason=${JSON.stringify(reason)}`);

  let result: { outcome: "closed" | "escalated" };
  try {
    result = await concludeIssue(issueNumber, reason, summary);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    log(`concludeIssue failed for #${issueNumber}: ${message}`);
    mcpFail(`Failed to conclude issue #${issueNumber}: ${message}`);
  }

  const text =
    result.outcome === "closed"
      ? `Issue #${issueNumber} was created by an Atoma agent (a sub-issue) and has been closed automatically. Phase-gating/aggregation for its parent has been checked.`
      : `Issue #${issueNumber} was opened directly by a human. It has NOT been closed automatically -- a comment mentioning them was posted with your reason/summary, asking them to review and close it themselves.`;

  return { text, meta: { session_ends: true } };
}

const { tools: TOOLS, dispatch } = buildMcpTools([
  defineMcpTool({
    name: "launch_sub_agent",
    description:
      "Dispatch Atoma agents onto sub-issues and immediately end the orchestrator session. " +
      "Call this ONCE after creating all sub-issues via GitHub MCP. " +
      "Each sub-issue can be assigned a different agent. " +
      "The orchestrator session ends immediately after this call returns. " +
      "The orchestrator will be automatically re-invoked when ALL sub-issues are closed.",
    schema: LAUNCH_SUB_AGENT_SCHEMA,
    handler: handleLaunchSubAgent,
  }),
  defineMcpTool({
    name: "request_close_issue",
    description:
      "Conclude work on YOUR CURRENT issue and end your session. This is the ONLY " +
      "correct way for the orchestrator to finish an issue -- do NOT call " +
      "github__close_issue yourself, and do NOT just stop responding without calling " +
      "this. The tool decides what happens next based on who opened THIS issue: " +
      "if it was created by another Atoma agent (a sub-issue), it is closed " +
      "automatically right now and phase-gating/aggregation is triggered for its " +
      "parent. If it was opened directly by a human (a root issue), it is NOT " +
      "closed -- instead a comment mentioning that human is posted with your reason " +
      "and summary, asking them to review and close it themselves.",
    schema: REQUEST_CLOSE_ISSUE_SCHEMA,
    handler: handleRequestCloseIssue,
  }),
]);

const server = new Server(
  { name: "atoma-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const { text, meta } = await dispatch(name, args);
    return {
      content: [{ type: "text", text }],
      isError: false,
      ...(meta ? { _meta: meta } : {}),
    };
  } catch (e) {
    log(`Handler error for ${name}: ${(e as Error).message}`);
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }
});

async function main(): Promise<void> {
  log("Starting atoma-mcp-server (stdio transport)");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) void main();

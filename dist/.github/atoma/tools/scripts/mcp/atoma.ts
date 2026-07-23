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
 */
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { gh } from "../lib/gh.ts";
import type { SubAgentTask } from "../lib/types.ts";

const SCRIPTS_DIR =
  process.env.ATOMA_SCRIPTS_DIR ?? join(process.env.GITHUB_WORKSPACE ?? ".", ".github/atoma/tools/scripts");

function log(msg: string): void {
  console.error(`[atoma-mcp] ${msg}`);
}

const TOOLS: Tool[] = [
  {
    name: "launch_sub_agent",
    description:
      "Dispatch Atoma agents onto sub-issues and immediately end the orchestrator session. " +
      "Call this ONCE after creating all sub-issues via GitHub MCP. " +
      "Each sub-issue can be assigned a different agent. " +
      "The orchestrator session ends immediately after this call returns. " +
      "The orchestrator will be automatically re-invoked when ALL sub-issues are closed.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              issue: { type: "integer", description: "The sub-issue number." },
              agent: { type: "string", description: "The agent to dispatch (e.g., 'engineer')." },
            },
            required: ["issue", "agent"],
          },
          description: "List of {issue, agent} pairs to dispatch.",
        },
      },
      required: ["tasks"],
    },
  },
  {
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
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why this issue's work is considered complete." },
        summary: {
          type: "string",
          description: "Final summary to include in the posted comment (e.g. an aggregation report).",
        },
      },
      required: ["reason"],
    },
  },
];

interface ToolTextResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
  _meta?: { session_ends?: boolean };
}

function mcpFail(message: string): never {
  throw new Error(message);
}

function handleLaunchSubAgent(args: Record<string, unknown>): ToolTextResult {
  const tasks = args.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    mcpFail(`tasks must be a non-empty list of {issue, agent} objects, got: ${JSON.stringify(tasks)}`);
  }
  for (const t of tasks as unknown[]) {
    if (typeof t !== "object" || t === null) mcpFail(`Each task must be an object, got: ${JSON.stringify(t)}`);
    const { issue, agent } = t as Record<string, unknown>;
    if (typeof issue !== "number" || issue <= 0) mcpFail(`Each task.issue must be a positive integer, got: ${issue}`);
    if (typeof agent !== "string" || !agent) mcpFail(`Each task.agent must be a string, got: ${agent}`);
  }
  const validTasks = tasks as SubAgentTask[];

  log(`Dispatching ${validTasks.length} sub-issue(s): ${JSON.stringify(validTasks)}`);

  // The orchestrator's OWN current issue (the parent, from the sub-issues'
  // point of view). Each dispatch below only overrides ISSUE_NUMBER in the
  // *subprocess's* env, never in this process's own env, so this stays stable
  // throughout the loop.
  const parentIssue = (process.env.ISSUE_NUMBER ?? "").trim();

  const script = join(SCRIPTS_DIR, "launch_sub_agent.ts");

  const dispatched: string[] = [];
  const errors: string[] = [];

  for (const { issue, agent } of validTasks) {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", script, "--issue", String(issue), "--agent", agent],
      env: { ...process.env, ISSUE_NUMBER: String(issue) },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      log(`Script failed for #${issue} (exit ${result.exitCode}): ${stderr}`);
      errors.push(`#${issue}/${agent}: ${stderr || "unknown error"}`);
    } else {
      log(`Script output for #${issue}: ${result.stdout.toString("utf8").trim()}`);
      dispatched.push(`#${issue}→${agent}`);
    }
  }

  // Best-effort comment on the PARENT issue so a human reading the parent's
  // thread has a full audit trail of what was dispatched.
  if (dispatched.length && parentIssue) {
    const bodyLines = ["Atoma: Launched sub-agent(s):", ...dispatched.map((d) => `- ${d}`)];
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

  return {
    content: [{ type: "text", text: summaryLines.join("\n") }],
    isError: false,
    _meta: { session_ends: true },
  };
}

function handleRequestCloseIssue(args: Record<string, unknown>): ToolTextResult {
  const reason = String(args.reason ?? "").trim();
  const summary = String(args.summary ?? "").trim();

  if (!reason) mcpFail("reason must be a non-empty string");

  const issueNumber = (process.env.ISSUE_NUMBER ?? "").trim();
  if (!issueNumber) mcpFail("ISSUE_NUMBER is not set in the environment");

  const script = join(SCRIPTS_DIR, "request_close_issue.ts");
  const cmd = ["bun", "run", script, "--issue", issueNumber, "--reason", reason];
  if (summary) cmd.push("--summary", summary);

  log(`Concluding issue #${issueNumber}: reason=${JSON.stringify(reason)}`);

  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    log(`request_close_issue.ts failed for #${issueNumber} (exit ${result.exitCode}): ${stderr}`);
    mcpFail(`Failed to conclude issue #${issueNumber}: ${stderr || "unknown error"}`);
  }

  const output = result.stdout.toString("utf8").trim();
  log(`request_close_issue.ts output for #${issueNumber}: ${output}`);

  const text = output.startsWith("closed:")
    ? `Issue #${issueNumber} was created by an Atoma agent (a sub-issue) and has been closed automatically. Phase-gating/aggregation for its parent has been checked.`
    : `Issue #${issueNumber} was opened directly by a human. It has NOT been closed automatically -- a comment mentioning them was posted with your reason/summary, asking them to review and close it themselves.`;

  return {
    content: [{ type: "text", text }],
    isError: false,
    _meta: { session_ends: true },
  };
}

const server = new Server(
  { name: "atoma-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === "launch_sub_agent") return handleLaunchSubAgent(args);
    if (name === "request_close_issue") return handleRequestCloseIssue(args);
    return { content: [{ type: "text", text: `Unknown: ${name}` }], isError: true };
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

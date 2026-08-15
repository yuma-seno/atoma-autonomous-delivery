#!/usr/bin/env bun
/** Foreground-only shell MCP server for deterministic agent validation commands. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpTools, defineMcpTool, z } from "../../../../lib/mcp-tool.ts";

const MAX_OUTPUT_BYTES = 1_000_000;

const SHELL_EXECUTE_SCHEMA = z.object({
  command: z.string().min(1).describe("Shell command to execute with bash."),
  working_directory: z.string().optional().describe("Directory in which to run the command. Defaults to the server working directory."),
  environment_variables: z.record(z.string()).optional().describe("Environment variables to add or override for this command."),
  input_data: z.string().optional().describe("Text to provide on standard input."),
  timeout_seconds: z.number().int().min(1).max(3600).optional().default(300).describe("Maximum foreground execution time in seconds. Defaults to 300."),
  execution_mode: z.literal("foreground").optional().default("foreground").describe("Only foreground execution is supported."),
});

/** Longest command echoed to the run log. Long enough to identify a command. */
const LOGGED_COMMAND_CHARS = 200;

/**
 * Record what the agent ran, so a run's cost can be read from its log.
 *
 * One engineer run was measured making 111 of these calls out of 152 tool calls,
 * across 134 inference iterations — and the log said only that
 * `shell__shell_execute` had been called, which cannot tell repeated searching
 * from repeated test runs from an agent going in circles.
 *
 * `console.error`, never the other one: this process's stdout is the JSON-RPC
 * transport.
 *
 * Commands are truncated rather than logged whole. GitHub Actions masks the
 * secrets it knows about, so an API key reaching a log comes out as `***`, but a
 * value derived from one does not. Truncating bounds how much of an unmasked
 * value can appear until masking is handled properly.
 */
function logCommand(command: string): void {
  const flat = command.replace(/\s+/g, " ").trim();
  const shown = flat.length > LOGGED_COMMAND_CHARS ? `${flat.slice(0, LOGGED_COMMAND_CHARS)}…` : flat;
  console.error(`[atoma-shell] exec: ${shown}`);
}

async function executeShell(args: z.infer<typeof SHELL_EXECUTE_SCHEMA>): Promise<string> {
  const startedAt = Date.now();
  logCommand(args.command);
  const child = Bun.spawn(["bash", "-lc", args.command], {
    cwd: args.working_directory ?? process.cwd(),
    env: { ...process.env, ...args.environment_variables },
    stdin: args.input_data === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (args.input_data !== undefined) {
    if (!child.stdin) throw new Error("Shell process stdin is unavailable");
    child.stdin.write(args.input_data);
    child.stdin.end();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, args.timeout_seconds * 1000);

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer));

  const truncate = (value: string): { text: string; truncated: boolean } => {
    const bytes = Buffer.from(value);
    return bytes.length <= MAX_OUTPUT_BYTES
      ? { text: value, truncated: false }
      : { text: bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"), truncated: true };
  };
  const out = truncate(stdout);
  const err = truncate(stderr);
  const elapsedMs = Date.now() - startedAt;

  // Size matters as much as count. Every byte returned here enters the session
  // and is resent on each later inference, so a few large outputs explain a
  // growing prompt better than a call count does.
  console.error(
    `[atoma-shell] exit=${exitCode} ${elapsedMs}ms ` +
      `stdout=${Buffer.from(out.text).length}B stderr=${Buffer.from(err.text).length}B` +
      (out.truncated || err.truncated ? " (truncated)" : ""),
  );

  return JSON.stringify({
    status: timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed",
    exit_code: exitCode,
    stdout: out.text,
    stderr: err.text,
    output_truncated: out.truncated || err.truncated,
    execution_time_ms: elapsedMs,
  });
}

const { tools, dispatch } = buildMcpTools([
  defineMcpTool({
    name: "shell_execute",
    description: "Execute one foreground bash command and return its exit code, stdout, stderr, and duration. Use this for tests, builds, linting, and focused read-only inspection. Set timeout_seconds for commands that may run longer than five minutes. Git and GitHub mutations remain blocked by the configured hook.",
    schema: SHELL_EXECUTE_SCHEMA,
    handler: executeShell,
  }),
]);

const server = new Server({ name: "atoma-shell-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const { text } = await dispatch(name, args);
    return { content: [{ type: "text", text }], isError: false };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${(error as Error).message ?? error}` }], isError: true };
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) void main();
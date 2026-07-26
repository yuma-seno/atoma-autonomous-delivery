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

async function executeShell(args: z.infer<typeof SHELL_EXECUTE_SCHEMA>): Promise<string> {
  const startedAt = Date.now();
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

  return JSON.stringify({
    status: timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed",
    exit_code: exitCode,
    stdout: out.text,
    stderr: err.text,
    output_truncated: out.truncated || err.truncated,
    execution_time_ms: Date.now() - startedAt,
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
#!/usr/bin/env bun
/**
 * Foreground-only shell MCP server for deterministic agent validation commands.
 *
 * Runs as the same OS user, on the same filesystem, as every other tool server --
 * no container, no separate home, nothing for an agent to reason about. That user
 * has no sudo, which is what makes the rest of the arrangement mean anything: with
 * sudo, `cat /proc/<pid>/environ` reads any process whatever else is arranged.
 *
 * It holds no credentials of its own (`env: {}` in tools.yaml). What it can and
 * cannot reach is in that file's `shell` entry, including the one exposure that is
 * accepted rather than closed.
 */
import { buildMcpTools, defineMcpTool, serveMcpServer, z } from "../../../../lib/mcp-tool.ts";
import { literalsFrom, redact } from "../../../../domain/redaction.ts";
import { capText, TOOL_OUTPUT_BUDGET } from "../../../../domain/tool-output.ts";
import { RUN_CREDENTIALS } from "../../../../domain/declared-secrets.ts";

/**
 * This server's diagnostics, prefixed like every other server's.
 *
 * `console.error`, never the other one: this process's stdout is the JSON-RPC
 * transport. The prefix is what identifies which server a line came from in a
 * run log that interleaves all five, which is why `serveMcpServer` takes it as
 * a parameter rather than owning one.
 */
function log(message: string): void {
  console.error(`[atoma-shell] ${message}`);
}

// The cap and the direction of the cut both come from `domain/tool-output.ts`.
// This server had its own `MAX_OUTPUT_BYTES = 1_000_000`, which was twenty times
// every other tool's and, on its own, more than a 200k context window -- and it kept
// the HEAD, so a build log that overran lost the compiler error and returned the
// banner. See that module for the measurements.

/**
 * Variables holding a credential, if this process was handed any.
 *
 * On a runner it is handed none, and this list is empty. Two things say so:
 * `tools.yaml` gives this server `env: {}`, and Atoma strips every credential
 * from a server that does not name one. The literal-value pass below therefore
 * finds nothing to remove, and only the shape patterns do any work.
 *
 * A third reason used to be here — "since #374 this process runs in a container
 * that cannot see the servers which DO hold them" — and #464 removed the
 * container. What stands in its place protects the OTHER servers rather than this
 * one: they make themselves unreadable. It is not a reason this list is empty, so
 * it does not belong in this comment.
 *
 * `redact_stream.ts` says the same thing about its own situation; this comment
 * used to claim the opposite, describing an environment the server had before
 * per-tool credential routing existed.
 *
 * It is kept for the case where the values ARE present: a hand-run `atoma` with
 * the keys exported in the shell. There the literal pass is the stronger of the
 * two, since an exact value needs no pattern to guess at.
 *
 * `ATOMA_PROVIDER` and the rest of the run's configuration are absent on
 * purpose. They are not secret, and redacting a value like `openai` would blank
 * every mention of the word.
 */
const SECRET_ENV_NAMES = [
  ...RUN_CREDENTIALS,
  // The two GitHub names a run does not supply but a project might, so a value under
  // either is still redacted from this server's own output.
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
] as const;

/**
 * Read once, at startup: the values do not change during a run, and rebuilding
 * the list per command would sort them on every call.
 */
const SECRET_LITERALS = literalsFrom(process.env, SECRET_ENV_NAMES);

const SHELL_EXECUTE_SCHEMA = z.object({
  command: z.string().min(1).describe("Shell command to execute with bash."),
  working_directory: z.string().optional().describe("Directory in which to run the command. Must be inside the checked-out repository; anywhere else is refused. Defaults to the server working directory."),
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
 * Redacted, then truncated. A command line is a place credentials appear —
 * pasted into a curl, exported before a script — and this log is written by the
 * process rather than by Actions, so nothing else would catch one. Truncation
 * still bounds what a shape nobody recognises can reveal.
 */
function logCommand(command: string): void {
  const flat = redact(command, SECRET_LITERALS).replace(/\s+/g, " ").trim();
  const shown = flat.length > LOGGED_COMMAND_CHARS ? `${flat.slice(0, LOGGED_COMMAND_CHARS)}…` : flat;
  log(`exec: ${shown}`);
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

  // Redact before truncating, so the size reported is the size of what is
  // actually returned, and before anything is returned at all: this value goes
  // into the session on the `atoma-data` branch and can be quoted into an issue
  // comment, neither of which GitHub Actions masks.
  //
  // `both` ends, because command output is both kinds of text at once: a quarter
  // at the front for the command's own echo or the first failing test, and the
  // rest at the end, where a build error is.
  //
  // The two streams SHARE one budget rather than each getting one, so a command
  // that writes heavily to both cannot return twice the intended volume. stdout
  // takes three quarters: a failing command's message on stderr is short, and the
  // detail that explains it is on stdout.
  const truncate = (raw: string, budget: number): { text: string; truncated: boolean } => {
    const capped = capText(redact(raw, SECRET_LITERALS), budget, "both");
    return { text: capped.text, truncated: capped.dropped > 0 };
  };
  const out = truncate(stdout, Math.floor(TOOL_OUTPUT_BUDGET * 0.75));
  const err = truncate(stderr, Math.floor(TOOL_OUTPUT_BUDGET * 0.25));
  const elapsedMs = Date.now() - startedAt;

  // Size matters as much as count. Every byte returned here enters the session
  // and is resent on each later inference, so a few large outputs explain a
  // growing prompt better than a call count does.
  log(
    `exit=${exitCode} ${elapsedMs}ms ` +
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
    description: "Execute one foreground bash command and return its exit code, stdout, stderr, and duration. Use this for tests, builds, linting, and focused read-only inspection. Set timeout_seconds for commands that may run longer than five minutes. Commands run on the same machine, as the same user, and with the same filesystem as every other tool: a file you write in the repository is the same file github__* commits and filesystem__* reads, at the same path. Writes OUTSIDE the repository mostly fail rather than silently not persisting: $HOME is read-only and system packages cannot be installed, though /tmp is writable for scratch that does not need to outlive the run. That is a real error you can read, not a write that looks like it worked. If something must persist, add it to `environment.setup_commands` in .github/atoma/config.json and say so in your report; a person merges that and the next run has it. Some commands are routed to MCP tools instead of running here -- Git mutations, `gh`, `curl`, `wget`, `ssh`, `scp`, `rsync` -- and the set may grow, so read the refusal rather than assuming a fixed list: each one names the tool to use in its place. Read-only Git inspection (status, diff, log) runs normally. Output is capped: a long stdout or stderr keeps its beginning and its END, with a marker naming how much was dropped from the middle, and `output_truncated` set. So a build log keeps its failure -- but if you see that marker, narrow the command (a specific test, `grep`, `tail`) rather than re-running the same one and expecting more.",
    schema: SHELL_EXECUTE_SCHEMA,
    handler: executeShell,
  }),
]);

async function main(): Promise<void> {
  await serveMcpServer({ name: "atoma-shell-mcp", version: "1.0.0", tools, dispatch, log });
}
if (import.meta.main) void main();
#!/usr/bin/env bun
/**
 * probe-http-transport.ts — can atoma actually use a tool server that is not a
 * child process?
 *
 * atoma#12 added MCP's Streamable HTTP transport: `url` reaches a server that is
 * already running, `command` still starts one over stdio, and both together start
 * a server and then speak HTTP to it. This runs all three against the released
 * binary.
 *
 * Worth measuring rather than reasoning about, because none of it is reachable
 * from a unit test. atoma's own tests cover the pure parts -- which of `command`
 * and `url` a definition means, and what messages an SSE body carries -- and stop
 * exactly where the socket begins. What is left over is the whole of the feature:
 * a session header echoed back, a notification arriving on a tool call's stream, a
 * server that is not listening yet when the first POST arrives.
 *
 * ## What it stands up
 *
 *   a fake MCP server over HTTP  -- sessions, SSE, and a warning about itself
 *   a fake LLM                    -- calls the tool once, then records what it got
 *   the real atoma                -- the released binary at the pinned version
 *
 * ## The three cases
 *
 *   1. `url` alone           -- something already running. No process, so no
 *                               stderr: `notifications/message` is the only way a
 *                               problem can reach the agent, and it does.
 *   2. `command` + `url`     -- atoma starts it and waits for it to bind. Proves
 *                               the readiness retry, and that a server atoma
 *                               started still has its stderr read.
 *   3. `env` with a `url` and no `command` -- refused when the tools file is read,
 *                               because there is no process to put it in. A
 *                               credential someone believes they routed and did
 *                               not is worse than an error.
 *
 * Run with `--serve <port> [--slow]` and this file IS the fake HTTP server, which
 * is how its behaviour stays next to the expectations about it. `--slow` waits
 * before binding, so case 2 measures the retry rather than getting lucky.
 *
 * Not part of the deliverable -- this repository's own CI, like probe-dumpable.sh.
 */

const STDERR_REPORT = "WARN the stderr channel reached the agent";
const NOTIFICATION_REPORT = "the notification channel reached the agent";
const SESSION = "probe-session-1";

// ── the fake MCP server, over HTTP ───────────────────────────────────────────

/**
 * Streamable HTTP, as much of it as the client uses: one POST per message, a
 * session id assigned at `initialize` and required afterwards, and a tool call
 * answered as an SSE stream carrying a notification ahead of the result.
 *
 * The session check is the point of returning one at all. A client that forgets to
 * echo `Mcp-Session-Id` would work perfectly against a server that does not care,
 * and fail against every real one.
 */
async function serve(port: number, slow: boolean): Promise<void> {
  // Case 2 spawns this and atoma starts POSTing immediately. Binding late is what
  // makes the readiness retry the thing under test rather than a race that happens
  // to go the right way.
  if (slow) await Bun.sleep(1500);
  process.stderr.write(`[probe-http] ${STDERR_REPORT}\n`);

  const sse = (...messages: unknown[]) =>
    new Response(messages.map((m) => `event: message\r\ndata: ${JSON.stringify(m)}\r\n\r\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });

  Bun.serve({
    port,
    async fetch(request) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const message = (await request.json()) as { id?: unknown; method?: string };
      const method = message.method ?? "";
      const session = request.headers.get("mcp-session-id");

      if (method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { logging: {}, tools: {} },
              serverInfo: { name: "probe-http", version: "0" },
            },
          },
          { headers: { "mcp-session-id": SESSION } },
        );
      }

      // Everything after `initialize` must carry the session back. A real server
      // answers 404 without it, and so does this one.
      if (session !== SESSION) {
        return new Response(`expected the session back, got ${session ?? "nothing"}`, { status: 404 });
      }

      if (method.startsWith("notifications/")) {
        // The right answer to a notification: accepted, nothing to read.
        return new Response(null, { status: 202 });
      }

      if (method === "logging/setLevel") {
        process.stderr.write(`[probe-http] setLevel received\n`);
        return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
      }

      if (method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "ping",
                description: "Answers pong. Exists so there is a result to attach a report to.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          },
        });
      }

      if (method === "tools/call") {
        // A stream, with the report ahead of the answer -- the ordering a real
        // server produces when something goes wrong while it works.
        return sse(
          {
            jsonrpc: "2.0",
            method: "notifications/message",
            params: { level: "warning", logger: "probe", data: NOTIFICATION_REPORT },
          },
          { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } },
        );
      }

      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `no ${method}` },
      });
    },
  });
  // Serve until killed. atoma's connection Drop kills a server it started; the one
  // this script starts for case 1 is killed by the probe.
  await new Promise(() => {});
}

// ── the fake LLM ─────────────────────────────────────────────────────────────

interface Captured {
  requests: number;
  tools: string[];
  toolMessages: string[];
}

function serveLlm(captured: Captured, tool: string) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        tools?: { function?: { name?: string } }[];
        messages?: { role: string; content?: unknown }[];
      };
      captured.requests += 1;
      for (const t of body.tools ?? []) if (t.function?.name) captured.tools.push(t.function.name);
      for (const m of body.messages ?? []) {
        if (m.role === "tool") {
          captured.toolMessages.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
        }
      }

      const first = captured.requests === 1;
      const message = first
        ? {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: tool, arguments: "{}" } }],
          }
        : { role: "assistant", content: "done" };
      return Response.json({
        choices: [{ message, finish_reason: first ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
}

// ── the run ──────────────────────────────────────────────────────────────────

function say(what: string): void {
  process.stdout.write(`\n=== ${what} ===\n`);
}

function result(name: string, value: unknown): void {
  process.stdout.write(`RESULT ${name}=${value}\n`);
}

const ATOMA = process.env.ATOMA_BIN ?? "atoma";
const DIR = `${process.env.RUNNER_TEMP ?? "/tmp"}/probe-http-transport`;

interface RunOutcome {
  exit: number;
  log: string;
  captured: Captured;
}

/** One atoma run against `toolsYaml`, with the fake LLM calling `tool` once. */
async function runAtoma(label: string, toolsYaml: string, tool: string): Promise<RunOutcome> {
  await Bun.write(`${DIR}/${label}-tools.yaml`, toolsYaml);
  await Bun.write(
    `${DIR}/${label}-agent.md`,
    [
      "---",
      "name: probe",
      "description: Calls one tool so there is a result to inspect.",
      "provider: openai",
      "model: probe-model",
      "mcp_servers:",
      "  - probe",
      "---",
      "",
      "Call the tool.",
      "",
    ].join("\n"),
  );
  await Bun.write(`${DIR}/${label}-prompt.txt`, "Call the tool once.\n");

  const captured: Captured = { requests: 0, tools: [], toolMessages: [] };
  const llm = serveLlm(captured, tool);
  const run = Bun.spawn(
    [
      ATOMA,
      "run",
      "--agent-def",
      `${DIR}/${label}-agent.md`,
      "--tools-file",
      `${DIR}/${label}-tools.yaml`,
      "--prompt-file",
      `${DIR}/${label}-prompt.txt`,
      "--max-iterations",
      "3",
    ],
    {
      env: {
        ...process.env,
        OPENAI_API_KEY: "probe-key",
        OPENAI_BASE_URL: `http://127.0.0.1:${llm.port}`,
        ATOMA_PROVIDER: "openai",
        RUST_LOG: "info",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  await llm.stop(true);
  return { exit, log: `${stdout}\n${stderr}`, captured };
}

async function probe(): Promise<number> {
  await Bun.$`rm -rf ${DIR}`.quiet();
  await Bun.$`mkdir -p ${DIR}`.quiet();
  const self = import.meta.path;
  let held = true;

  // ── 1. a server that is already running ───────────────────────────────────
  say("1. url alone: a server atoma did not start");
  const port = 9251;
  const server = Bun.spawn(["bun", "run", self, "--serve", String(port)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // It binds immediately in this mode; one short wait is enough and keeps the
  // readiness retry out of a case that is not about it.
  await Bun.sleep(700);

  const remote = await runAtoma(
    "remote",
    `probe:\n  url: http://127.0.0.1:${port}/mcp\n  hooks: {}\n`,
    "probe__ping",
  );
  server.kill();

  const remoteText = remote.captured.toolMessages.join("\n");
  result("remote_exit", remote.exit);
  result("remote_tools_registered", remote.captured.tools.join(" "));
  result("remote_tool_answered", remoteText.includes("pong"));
  const remoteAnnotated = remoteText.includes(NOTIFICATION_REPORT);
  result("remote_notification_reached_the_agent", remoteAnnotated);
  // The session is what a real server enforces, and a 404 is what it answers
  // without one. A run that got this far echoed it back on every request.
  result("remote_session_was_echoed", remote.exit === 0 && remote.captured.requests >= 2);
  result("remote_setLevel_answered", remote.log.includes("setLevel received"));
  if (remote.exit !== 0 || !remoteAnnotated) {
    held = false;
    process.stdout.write(`\n--- atoma (remote) ---\n${remote.log}\n`);
  }
  process.stdout.write(`${remoteText || "(nothing)"}\n`);

  // ── 2. started here, spoken to over HTTP ──────────────────────────────────
  say("2. command and url: atoma starts it, then waits for it to bind");
  const localPort = 9252;
  const local = await runAtoma(
    "local",
    [
      "probe:",
      "  command: bun",
      `  args: ["run", "${self}", "--serve", "${localPort}", "--slow"]`,
      `  url: http://127.0.0.1:${localPort}/mcp`,
      "  env: {}",
      "  hooks: {}",
      "",
    ].join("\n"),
    "probe__ping",
  );

  const localText = local.captured.toolMessages.join("\n");
  result("local_exit", local.exit);
  result("local_tool_answered", localText.includes("pong"));
  // The whole reason to start a server and then use HTTP: atoma owns its stderr,
  // so the fallback channel still works. A remote server has nothing like it.
  const localStderr = localText.includes("the stderr channel reached the agent");
  result("local_stderr_reached_the_agent", localStderr);
  result("local_notification_reached_the_agent", localText.includes(NOTIFICATION_REPORT));
  // It slept 1.5s before binding, so a first POST that was not retried would have
  // failed the run outright.
  result("local_waited_for_the_port", local.log.includes("not accepting connections yet"));
  if (local.exit !== 0 || !localStderr) {
    held = false;
    process.stdout.write(`\n--- atoma (local) ---\n${local.log}\n`);
  }
  process.stdout.write(`${localText || "(nothing)"}\n`);

  // ── 3. a credential that would have gone nowhere ──────────────────────────
  say("3. env with a url and no command: refused, not ignored");
  const refused = await runAtoma(
    "refused",
    `probe:\n  url: http://127.0.0.1:${port}/mcp\n  env:\n    GH_TOKEN: "\${GH_TOKEN}"\n  hooks: {}\n`,
    "probe__ping",
  );
  const saidWhy = /declares 'env' but no 'command'/.test(refused.log);
  result("refused_exit", refused.exit);
  result("refused_says_why", saidWhy);
  if (refused.exit === 0 || !saidWhy) {
    held = false;
    process.stdout.write(`\n--- atoma (refused) ---\n${refused.log}\n`);
  }

  say("4. verdict");
  result("required_all_held", held);
  return held ? 0 : 1;
}

const serveAt = Bun.argv.indexOf("--serve");
if (serveAt !== -1) {
  await serve(Number(Bun.argv[serveAt + 1]), Bun.argv.includes("--slow"));
} else {
  process.exit(await probe());
}

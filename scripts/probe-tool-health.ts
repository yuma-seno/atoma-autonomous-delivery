#!/usr/bin/env bun
/**
 * probe-tool-health.ts — does a server's report about itself actually reach the
 * model?
 *
 * atoma v0.1.18 (atoma#13) attaches what a tool server said about its own trouble
 * to that server's next tool result. #514 is the instruction that acts on it. Both
 * are built on a claim that had never been run: that the note survives the whole
 * path from a server's stderr line, or its `notifications/message`, into the
 * request the model receives.
 *
 * Nothing in either repository's test suite covers that path. atoma's tests reach
 * the pure functions and a mock tool port; this repository's reach the wording.
 * Between them sits a protocol handshake, a spawned reader task and a request body
 * -- and the failure mode of this feature is silence, which is exactly what a
 * healthy run looks like. So it is measured rather than reasoned about.
 *
 * ## What this stands up
 *
 *   a fake MCP server   -- warns on BOTH channels, so one run tests both
 *   a fake LLM          -- calls the tool once, then records what it was sent
 *   the real atoma       -- the released binary, not a build of main
 *
 * The fake LLM is the assertion point, and it has to be: the annotation's whole
 * purpose is to be in front of the model, and the only place that is observable is
 * the request body. Reading atoma's own log would prove the note was made, not
 * that it arrived.
 *
 * Run with `--mcp` and this file IS the fake server, which is how the server's
 * source stays next to the expectations about it.
 *
 * Not part of the deliverable -- this repository's own CI, like probe-dumpable.sh.
 */

const STDERR_REPORT = "WARN the stderr channel reached the agent";
const NOTIFICATION_REPORT = "the notification channel reached the agent";
const TOOL = "probe__ping";

// ── the fake MCP server ──────────────────────────────────────────────────────

/**
 * A stdio MCP server that declares `logging`, reports on both channels, and
 * answers one tool.
 *
 * The stderr line goes out at startup on purpose: that is the case the whole
 * feature exists for (#499's reranker failed while the server was starting, long
 * before any search arrived), and it is the one with a race in it -- atoma spawns
 * the stderr reader after `initialize` returns, so whether the line is read before
 * the first tool result is a matter of scheduling. Measuring it is the point.
 */
async function serveMcp(): Promise<void> {
  process.stderr.write(`[probe-tools] ${STDERR_REPORT}\n`);

  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
  const seen: string[] = [];

  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: { id?: unknown; method?: string };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const method = message.method ?? "";
      seen.push(method);

      if (method === "initialize") {
        reply(message.id, {
          protocolVersion: "2024-11-05",
          // The declaration atoma reads before it bothers with logging/setLevel.
          capabilities: { logging: {}, tools: {} },
          serverInfo: { name: "probe-tools", version: "0" },
        });
      } else if (method === "logging/setLevel") {
        // Recorded on stderr rather than kept: the probe reads the run log for it,
        // and a server that answers this is the only proof the request was sent.
        process.stderr.write(`[probe-tools] setLevel received\n`);
        reply(message.id, {});
      } else if (method === "tools/list") {
        reply(message.id, {
          tools: [
            {
              name: "ping",
              description: "Answers pong. Exists so there is a result to attach a report to.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        });
      } else if (method === "tools/call") {
        // Before the response, deliberately. A server reports as it works, so the
        // notification arrives while atoma is waiting for the answer -- which is
        // where it used to be discarded.
        send({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "warning", logger: "probe", data: NOTIFICATION_REPORT },
        });
        reply(message.id, { content: [{ type: "text", text: "pong" }] });
      } else if (method.startsWith("notifications/")) {
        // No id, no answer.
      } else if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no ${method}` } });
      }
    }
  }
}

// ── the fake LLM ─────────────────────────────────────────────────────────────

interface LlmMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

interface Captured {
  requests: number;
  toolMessages: string[];
}

/**
 * Two turns: call the tool, then end. The second request carries the tool result,
 * which is what is being measured.
 */
function serveLlm(captured: Captured) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages?: LlmMessage[] };
      captured.requests += 1;
      for (const message of body.messages ?? []) {
        if (message.role === "tool") {
          captured.toolMessages.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
        }
      }

      const first = captured.requests === 1;
      const message = first
        ? {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: TOOL, arguments: "{}" } }],
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

async function probe(): Promise<number> {
  const atoma = process.env.ATOMA_BIN ?? "atoma";
  const dir = `${process.env.RUNNER_TEMP ?? "/tmp"}/probe-tool-health`;
  await Bun.$`rm -rf ${dir}`.quiet();
  await Bun.$`mkdir -p ${dir}`.quiet();

  const self = import.meta.path;
  await Bun.write(
    `${dir}/tools.yaml`,
    `probe:\n  command: bun\n  args: ["run", "${self}", "--mcp"]\n  env: {}\n  hooks: {}\n`,
  );
  await Bun.write(
    `${dir}/agent.md`,
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
  await Bun.write(`${dir}/prompt.txt`, "Call probe__ping once.\n");

  const captured: Captured = { requests: 0, toolMessages: [] };
  const llm = serveLlm(captured);

  say("1. the run");
  const run = Bun.spawn(
    [
      atoma,
      "run",
      "--agent-def",
      `${dir}/agent.md`,
      "--tools-file",
      `${dir}/tools.yaml`,
      "--prompt-file",
      `${dir}/prompt.txt`,
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

  result("atoma_exit", exit);
  result("llm_requests", captured.requests);
  result("tool_messages", captured.toolMessages.length);

  // The whole point: what the model was actually handed.
  say("2. what reached the model");
  const toolText = captured.toolMessages.join("\n---\n");
  process.stdout.write(`${toolText || "(nothing)"}\n`);

  const answered = toolText.includes("pong");
  const annotated = toolText.includes("reported by the 'probe' server");
  const fromNotification = toolText.includes(NOTIFICATION_REPORT);
  const fromStderr = toolText.includes("the stderr channel reached the agent");
  const separated = toolText.includes("not part of the answer above");

  result("tool_answered", answered);
  result("annotation_present", annotated);
  result("annotation_from_notification", fromNotification);
  result("annotation_from_stderr", fromStderr);
  result("annotation_names_itself_apart", separated);

  say("3. what atoma's own log says");
  const log = `${stdout}\n${stderr}`;
  result("setLevel_answered", log.includes("setLevel received"));
  result("logged_the_notification", log.includes("[MCP:probe:log]"));
  for (const line of log.split("\n").filter((l) => /MCP:probe/.test(l))) {
    process.stdout.write(`${line}\n`);
  }

  // The notification channel is the primary one and has no race in it: it arrives
  // on the connection atoma is already reading, in the middle of the call. That is
  // what has to hold. The stderr line is reported either way -- it depends on when
  // a spawned reader task gets scheduled, and knowing which way it went is the
  // reason this exists.
  const required = answered && annotated && fromNotification && separated;
  say("4. verdict");
  result("required_all_held", required);
  result("stderr_note_made_the_first_call", fromStderr);
  if (!required) {
    process.stdout.write("\n--- atoma stdout ---\n" + stdout + "\n--- atoma stderr ---\n" + stderr + "\n");
  }
  return required ? 0 : 1;
}

if (Bun.argv.includes("--mcp")) {
  await serveMcp();
} else {
  process.exit(await probe());
}

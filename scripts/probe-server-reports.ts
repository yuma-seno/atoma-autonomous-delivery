#!/usr/bin/env bun
/**
 * probe-server-reports.ts — does a server we ship actually report over the
 * protocol?
 *
 * #519 moved this repository's servers off "write WARN to stderr and hope atoma's
 * word-matching catches it" and onto MCP's `notifications/message`, where the level
 * is a field. Everything about that is testable except the part that matters: that
 * a real server, started as a real process, puts the notification on the wire.
 *
 * ## What it does
 *
 * Speaks MCP to `mcp/github.ts` as a client would, and forces a report it can
 * predict: `PATH=/tmp` alone. `harden.ts` narrows PATH by dropping world-writable
 * directories, finds that dropping them would leave nothing, refuses to leave the
 * server with no PATH at all -- and says so. A real fault, forced by an
 * arrangement rather than by a stub.
 *
 * That report is raised at **module scope**, before `serveMcpServer` is called, so
 * it also exercises the half that cannot be reached any other way: a report made
 * before there is anywhere to send it is held, and goes out when the client says
 * the session is live. #499's reranker fails at startup too, which is why this is
 * the case worth proving rather than a convenient one.
 *
 * No atoma here, and that is deliberate: atoma's half -- reading the notification
 * and attaching it to the next tool result -- is measured in probe-tool-health.ts
 * against the released binary. This is the other end of the same wire.
 *
 * Not part of the deliverable -- this repository's own CI, like probe-dumpable.sh.
 */

const SERVER = "src/atoma/tools/scripts/mcp/github.ts";
/** What `harden.ts` says when narrowing PATH would leave nothing behind. */
const EXPECTED = "every PATH entry looked writable";

function say(what: string): void {
  process.stdout.write(`\n=== ${what} ===\n`);
}

function result(name: string, value: unknown): void {
  process.stdout.write(`RESULT ${name}=${value}\n`);
}

interface Message {
  id?: unknown;
  method?: string;
  params?: { level?: string; data?: unknown };
  result?: unknown;
}

async function probe(): Promise<number> {
  say("1. the server, with a PATH it has to refuse to narrow");
  // `/tmp` is world-writable, so it is the whole of a PATH that harden cannot fix.
  // bun is invoked by its own absolute path, because this PATH could not find it.
  const server = Bun.spawn([process.execPath, "run", SERVER], {
    env: {
      ...process.env,
      PATH: "/tmp",
      // Nothing here calls a tool, so no token is needed and none is given.
      GH_TOKEN: "",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Flushed every time: the sink buffers, and a handshake that never left this
  // process would look exactly like a server that never answered.
  const send = (message: unknown) => {
    server.stdin.write(`${JSON.stringify(message)}\n`);
    server.stdin.flush();
  };
  const messages: Message[] = [];

  // Read stdout as the client half of the protocol: one JSON value per line.
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of server.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as Message);
        } catch {
          // Not JSON on the transport is a defect of its own: stdout IS the
          // transport for a stdio server, so anything else there breaks the
          // connection. Kept as a message so it shows up in the listing below.
          messages.push({ method: `unparseable: ${line.slice(0, 80)}` });
        }
      }
    }
  })();

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { logging: {} },
      clientInfo: { name: "probe", version: "0" },
    },
  });

  // Wait for the handshake before saying the session is live, the way a client does.
  const deadline = Date.now() + 20_000;
  while (!messages.some((m) => m.id === 1) && Date.now() < deadline) await Bun.sleep(50);
  const initialize = messages.find((m) => m.id === 1);
  const capabilities = (initialize?.result as { capabilities?: Record<string, unknown> } | undefined)
    ?.capabilities;
  result("server_initialized", initialize !== undefined);
  // Without this declared, the SDK's `sendLoggingMessage` returns without sending
  // and every report disappears silently.
  result("declares_logging", capabilities?.logging !== undefined);

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "logging/setLevel", params: { level: "warning" } });

  say("2. what it says about itself");
  const until = Date.now() + 10_000;
  while (
    !messages.some((m) => m.method === "notifications/message") &&
    Date.now() < until
  ) {
    await Bun.sleep(50);
  }

  const reports = messages.filter((m) => m.method === "notifications/message");
  const setLevel = messages.find((m) => m.id === 2);
  result("setLevel_answered", setLevel !== undefined);
  result("reports_received", reports.length);
  for (const report of reports) {
    process.stdout.write(`  ${report.params?.level}: ${String(report.params?.data)}\n`);
  }

  const held = reports.some(
    (m) => m.params?.level === "warning" && String(m.params?.data).includes(EXPECTED),
  );
  // The whole mechanism in one value: the report was raised before the server had
  // anywhere to send it, and it arrived anyway.
  result("startup_report_arrived_after_the_handshake", held);

  say("3. and does not say it twice");
  server.kill();
  await reading.catch(() => {});
  const stderr = await new Response(server.stderr).text();
  // It moved channels. A line still on stderr would be atoma's word-matching
  // fallback picking up the same thing a second time, in front of the agent.
  const alsoOnStderr = stderr.includes(EXPECTED);
  result("same_report_still_on_stderr", alsoOnStderr);
  const severityInLog = /\b(warn|warning|fatal|panic)\b/i.test(stderr);
  result("stderr_carries_a_severity_word", severityInLog);
  if (stderr.trim()) process.stdout.write(`--- server stderr ---\n${stderr.trim()}\n`);

  say("4. verdict");
  const everythingHeld = initialize !== undefined && capabilities?.logging !== undefined && held && !alsoOnStderr;
  result("required_all_held", everythingHeld);
  return everythingHeld ? 0 : 1;
}

process.exit(await probe());

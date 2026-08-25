#!/usr/bin/env bun
/**
 * probe-server-reports.ts — does a report actually reach the wire?
 *
 * #519 moved this repository's servers off "write WARN to stderr and hope atoma's
 * word-matching catches it" and onto MCP's `notifications/message`, where the level
 * is a field. Everything about that is checkable by reading the source except the
 * part that matters: that a server, started as a real process, puts the
 * notification on the wire — and that a report raised *before* it had anywhere to
 * send it still arrives.
 *
 * That second half is what earns a probe. #499's reranker fails while loading and
 * `harden.ts` speaks at module scope, both long before any tool is called, so a
 * report that could only travel through an open connection would be the one report
 * that never arrives.
 *
 * ## Two halves, and what each is worth
 *
 * **1. `mcp/github.ts`, the real thing.** Asked only what a real server can be asked
 * without breaking it on purpose: does it declare the `logging` capability, and does
 * it answer `logging/setLevel`. That capability is the silent one — the SDK's
 * `sendLoggingMessage` returns without sending when it is missing, so undeclaring it
 * stops every report while nothing anywhere fails.
 *
 * **2. a server built out of the same parts.** `--serve` makes this file a server
 * that uses the real `serveMcpServer` and the real `report`, and raises a report at
 * module scope. Only the message is invented; the machinery under it is what every
 * shipped server runs.
 *
 * The honest limit: this does not prove that `search.ts` reports when its reranker
 * fails. Forcing that needs the 544MB model and an unwritable cache, and forcing
 * `harden.ts`'s PATH refusal turned out to be unreachable from outside — `bun run`
 * puts its own directories on PATH, so the "every entry is unsafe" case cannot be
 * arranged. What holds those call sites is `tests/contract/server-reports.test.ts`,
 * which checks that the texts exist and are not on `log()`.
 *
 * atoma's half — reading the notification and attaching it to the next tool result —
 * is measured in probe-tool-health.ts against the released binary. This is the other
 * end of the same wire.
 *
 * Not part of the deliverable -- this repository's own CI, like probe-dumpable.sh.
 */
import { buildMcpTools, defineMcpTool, serveMcpServer, z } from "../src/lib/mcp-tool.ts";
import { report } from "../src/lib/mcp-report.ts";

const REAL_SERVER = "src/atoma/tools/scripts/mcp/github.ts";
const STARTUP_REPORT = "raised before this server had anywhere to send it";

// ── the server built out of the shipped parts ────────────────────────────────

async function serve(): Promise<void> {
  // At module scope, which is the case that needs proving: there is no connection
  // yet, so this is held. `harden.ts` and `search.ts`'s preload both speak here.
  report("warning", STARTUP_REPORT);

  const { tools, dispatch } = buildMcpTools([
    defineMcpTool({
      name: "ping",
      description: "Answers pong. Exists so the server has a tool to list.",
      schema: z.object({}),
      handler: () => "pong",
    }),
  ]);
  await serveMcpServer({
    name: "probe-report-server",
    version: "0",
    tools,
    dispatch,
    log: (message) => process.stderr.write(`[probe-report] ${message}\n`),
  });
}

// ── the client half ──────────────────────────────────────────────────────────

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
  result?: { capabilities?: Record<string, unknown> };
}

interface Session {
  messages: Message[];
  stderr: string;
}

/**
 * Speak the handshake to one server and collect what it says.
 *
 * The client half of MCP, written out rather than taken from the SDK, because what
 * is being measured is what appears on the transport.
 */
async function talkTo(script: string, args: string[], waitForReport: boolean): Promise<Session> {
  const server = Bun.spawn([process.execPath, "run", script, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_TOKEN: "" },
  });

  // Flushed every time: the sink buffers, and a handshake that never left this
  // process would look exactly like a server that never answered.
  const send = (message: unknown) => {
    server.stdin.write(`${JSON.stringify(message)}\n`);
    server.stdin.flush();
  };

  const messages: Message[] = [];
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
          // stdout IS the transport for a stdio server, so anything else here
          // breaks the connection. Kept, so it shows up in the listing.
          messages.push({ method: `unparseable: ${line.slice(0, 80)}` });
        }
      }
    }
  })();

  const waitFor = async (found: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (!found() && Date.now() < deadline) await Bun.sleep(50);
  };

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
  await waitFor(() => messages.some((m) => m.id === 1), 20_000);

  // The session is live only once this is sent, which is when a held report goes
  // out. Sending it is the client's half of that.
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "logging/setLevel", params: { level: "warning" } });
  await waitFor(() => messages.some((m) => m.id === 2), 10_000);
  if (waitForReport) {
    await waitFor(() => messages.some((m) => m.method === "notifications/message"), 10_000);
  }

  server.kill();
  await reading.catch(() => {});
  const stderr = await new Response(server.stderr).text();
  return { messages, stderr };
}

async function probe(): Promise<number> {
  let held = true;

  say("1. a server we ship: is the channel open at all");
  const real = await talkTo(REAL_SERVER, [], false);
  const initialized = real.messages.find((m) => m.id === 1);
  const declares = initialized?.result?.capabilities?.logging !== undefined;
  result("real_server_initialized", initialized !== undefined);
  // The silent one. Without it the SDK's `sendLoggingMessage` returns without
  // sending, so every report stops arriving and nothing anywhere fails.
  result("real_server_declares_logging", declares);
  result("real_server_answered_setLevel", real.messages.some((m) => m.id === 2));
  if (!declares) held = false;

  say("2. the same machinery, with something to report");
  const fixture = await talkTo(import.meta.path, ["--serve"], true);
  const reports = fixture.messages.filter((m) => m.method === "notifications/message");
  result("reports_received", reports.length);
  for (const line of reports) {
    process.stdout.write(`  ${line.params?.level}: ${String(line.params?.data)}\n`);
  }
  const arrived = reports.some(
    (m) => m.params?.level === "warning" && String(m.params?.data).includes(STARTUP_REPORT),
  );
  // The whole mechanism in one value: raised before there was anywhere to send it,
  // and it arrived anyway.
  result("startup_report_arrived_after_the_handshake", arrived);
  if (!arrived) held = false;

  say("3. and not twice");
  // It moved channels. The same text still on stderr would be atoma's word-matching
  // fallback picking it up a second time, in front of the agent.
  const echoed = fixture.stderr.includes(STARTUP_REPORT);
  result("same_report_also_on_stderr", echoed);
  if (echoed) held = false;
  if (fixture.stderr.trim()) process.stdout.write(`--- fixture stderr ---\n${fixture.stderr.trim()}\n`);
  if (real.stderr.trim()) process.stdout.write(`--- real server stderr ---\n${real.stderr.trim()}\n`);

  say("4. verdict");
  result("required_all_held", held);
  return held ? 0 : 1;
}

if (Bun.argv.includes("--serve")) {
  await serve();
} else {
  process.exit(await probe());
}

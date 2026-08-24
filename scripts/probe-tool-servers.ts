#!/usr/bin/env bun
/**
 * probe-tool-servers.ts — do the tool servers actually start, at the layout a run
 * uses?
 *
 * `atoma-check` is scan-secrets → typecheck → synth → test, and **not one of those
 * starts a tool server as a process.** #506 records four defects of one shape in a
 * single day, all green in CI, all found only after deploying: the worst was #496,
 * where moving the machinery out of the work tree put `node_modules` out of reach
 * of the module-resolution walk and the search server could not start at all.
 * Atoma treats a server that will not initialise as fatal, so one unresolvable
 * import took every run down.
 *
 * Nothing in CI would say so, because nothing in CI ran a server.
 *
 * ## What this asks, and what it costs
 *
 * One turn of a run: every server in `tools.yaml` spawns, answers `initialize`,
 * and registers its tools. Then the fake LLM says stop. No provider is called and
 * no tool is called -- the question is whether the servers come up, and the answer
 * to that is the tool list.
 *
 * The tool list is read from the request the model receives, which is where a
 * server that came up but registered nothing becomes visible. Reading atoma's log
 * would show a connection; only the request shows what the agent was given.
 *
 * ## The layout is the point
 *
 * Running the servers from the work tree would prove nothing about #496: that
 * defect is entirely about WHERE the files are. So this reproduces the two facts
 * the runner's install step establishes --
 *
 *   - the machinery lives at `${RUNNER_TEMP}/atoma-machinery`, out of the work tree
 *   - the libraries a server imports live at `${RUNNER_TEMP}/node_modules`, beside
 *     it rather than in the project's own tree
 *
 * -- and `assertLayoutStillMatches` fails if `atoma-runner.wac.ts` stops saying
 * either. A probe that quietly tested a layout the runner no longer uses would be
 * worse than no probe, which is #506's own argument against fake servers.
 *
 * ## What it does not catch
 *
 * #499: the reranker's cache turning read-only. The load is deliberately started in
 * the background and not awaited (#488), so a run initialises fine and the failure
 * is 60 seconds away. Any warning a server does manage to emit in that window is
 * printed here, but nothing waits for one. That case is now covered at run time
 * instead -- atoma v0.1.18 hands the warning to the agent (atoma#13, #514).
 *
 * Not part of the deliverable -- this repository's own CI, like probe-dumpable.sh.
 */

import { existsSync } from "node:fs";

const RUNNER_TEMP = process.env.RUNNER_TEMP ?? "/tmp";
const MACHINERY = `${RUNNER_TEMP}/atoma-machinery`;
const TOOLS_FILE = `${MACHINERY}/.github/atoma/tools/tools.yaml`;
const RUNNER_WAC = "src/workflows/atoma-runner.wac.ts";

function say(what: string): void {
  process.stdout.write(`\n=== ${what} ===\n`);
}

function result(name: string, value: unknown): void {
  process.stdout.write(`RESULT ${name}=${value}\n`);
}

/**
 * The coupling this probe cannot verify by running: that the layout below is still
 * the one the runner builds.
 *
 * Pinned as strings out of the workflow source rather than imported, because these
 * are shell text inside a generated `run:` block and not values a module exports.
 * If the runner moves either directory, this fails and says which -- the same
 * bargain the contract tests make.
 *
 * The needles start after the `${`, which is not fussiness: in that file the shell
 * text lives inside TypeScript template literals, so a `#!/usr/bin/env bun
/**
 * probe-tool-servers.ts — do the tool servers actually start, at the layout a run
 * uses?
 *
 * `atoma-check` is scan-secrets → typecheck → synth → test, and **not one of those
 * starts a tool server as a process.** #506 records four defects of one shape in a
 * single day, all green in CI, all found only after deploying: the worst was #496,
 * where moving the machinery out of the work tree put `node_modules` out of reach
 * of the module-resolution walk and the search server could not start at all.
 * Atoma treats a server that will not initialise as fatal, so one unresolvable
 * import took every run down.
 *
 * Nothing in CI would say so, because nothing in CI ran a server.
 *
 * ## What this asks, and what it costs
 *
 * One turn of a run: every server in `tools.yaml` spawns, answers `initialize`,
 * and registers its tools. Then the fake LLM says stop. No provider is called and
 * no tool is called -- the question is whether the servers come up, and the answer
 * to that is the tool list.
 *
 * The tool list is read from the request the model receives, which is where a
 * server that came up but registered nothing becomes visible. Reading atoma's log
 * would show a connection; only the request shows what the agent was given.
 *
 * ## The layout is the point
 *
 * Running the servers from the work tree would prove nothing about #496: that
 * defect is entirely about WHERE the files are. So this reproduces the two facts
 * the runner's install step establishes --
 *
 *   - the machinery lives at `${RUNNER_TEMP}/atoma-machinery`, out of the work tree
 *   - the libraries a server imports live at `${RUNNER_TEMP}/node_modules`, beside
 *     it rather than in the project's own tree
 *
 * -- and `assertLayoutStillMatches` fails if `atoma-runner.wac.ts` stops saying
 * either. A probe that quietly tested a layout the runner no longer uses would be
 * worse than no probe, which is #506's own argument against fake servers.
 *
 * ## What it does not catch
 *
 * #499: the reranker's cache turning read-only. The load is deliberately started in
 * the background and not awaited (#488), so a run initialises fine and the failure
 * is 60 seconds away. Any warning a server does manage to emit in that window is
 * printed here, but nothing waits for one. That case is now covered at run time
 * instead -- atoma v0.1.18 hands the warning to the agent (atoma#13, #514).
 *
 * Not part of the deliverable -- this repository's own CI, like probe-dumpable.sh.
 */

import { existsSync } from "node:fs";

const RUNNER_TEMP = process.env.RUNNER_TEMP ?? "/tmp";
const MACHINERY = `${RUNNER_TEMP}/atoma-machinery`;
const TOOLS_FILE = `${MACHINERY}/.github/atoma/tools/tools.yaml`;
const RUNNER_WAC = "src/workflows/atoma-runner.wac.ts";

function say(what: string): void {
  process.stdout.write(`\n=== ${what} ===\n`);
}

function result(name: string, value: unknown): void {
  process.stdout.write(`RESULT ${name}=${value}\n`);
}

/**
 * The coupling this probe cannot verify by running: that the layout below is still
 * the one the runner builds.
 *
 meant for the shell is
 * written `\#!/usr/bin/env bun
/**
 * probe-tool-servers.ts — do the tool servers actually start, at the layout a run
 * uses?
 *
 * `atoma-check` is scan-secrets → typecheck → synth → test, and **not one of those
 * starts a tool server as a process.** #506 records four defects of one shape in a
 * single day, all green in CI, all found only after deploying: the worst was #496,
 * where moving the machinery out of the work tree put `node_modules` out of reach
 * of the module-resolution walk and the search server could not start at all.
 * Atoma treats a server that will not initialise as fatal, so one unresolvable
 * import took every run down.
 *
 * Nothing in CI would say so, because nothing in CI ran a server.
 *
 * ## What this asks, and what it costs
 *
 * One turn of a run: every server in `tools.yaml` spawns, answers `initialize`,
 * and registers its tools. Then the fake LLM says stop. No provider is called and
 * no tool is called -- the question is whether the servers come up, and the answer
 * to that is the tool list.
 *
 * The tool list is read from the request the model receives, which is where a
 * server that came up but registered nothing becomes visible. Reading atoma's log
 * would show a connection; only the request shows what the agent was given.
 *
 * ## The layout is the point
 *
 * Running the servers from the work tree would prove nothing about #496: that
 * defect is entirely about WHERE the files are. So this reproduces the two facts
 * the runner's install step establishes --
 *
 *   - the machinery lives at `${RUNNER_TEMP}/atoma-machinery`, out of the work tree
 *   - the libraries a server imports live at `${RUNNER_TEMP}/node_modules`, beside
 *     it rather than in the project's own tree
 *
 * -- and `assertLayoutStillMatches` fails if `atoma-runner.wac.ts` stops saying
 * either. A probe that quietly tested a layout the runner no longer uses would be
 * worse than no probe, which is #506's own argument against fake servers.
 *
 * ## What it does not catch
 *
 * #499: the reranker's cache turning read-only. The load is deliberately started in
 * the background and not awaited (#488), so a run initialises fine and the failure
 * is 60 seconds away. Any warning a server does manage to emit in that window is
 * printed here, but nothing waits for one. That case is now covered at run time
 * instead -- atoma v0.1.18 hands the warning to the agent (atoma#13, #514).
 *
 * Not part of the deliverable -- this repository's own CI, like probe-dumpable.sh.
 */

import { existsSync } from "node:fs";

const RUNNER_TEMP = process.env.RUNNER_TEMP ?? "/tmp";
const MACHINERY = `${RUNNER_TEMP}/atoma-machinery`;
const TOOLS_FILE = `${MACHINERY}/.github/atoma/tools/tools.yaml`;
const RUNNER_WAC = "src/workflows/atoma-runner.wac.ts";

function say(what: string): void {
  process.stdout.write(`\n=== ${what} ===\n`);
}

function result(name: string, value: unknown): void {
  process.stdout.write(`RESULT ${name}=${value}\n`);
}

/**
 * The coupling this probe cannot verify by running: that the layout below is still
 * the one the runner builds.
 *
 and a needle spanning it silently never matches. It cost this probe
 * one red run to find out.
 */
async function assertLayoutStillMatches(): Promise<boolean> {
  const wac = await Bun.file(RUNNER_WAC).text();
  const expectations: [string, string][] = [
    ["machinery_out_of_the_work_tree", "RUNNER_TEMP}/atoma-machinery"],
    ["libraries_beside_the_machinery", 'RUNNER_TEMP}" && bun add'],
  ];
  let held = true;
  for (const [name, text] of expectations) {
    const present = wac.includes(text);
    result(name, present);
    if (!present) {
      process.stdout.write(`  ${RUNNER_WAC} no longer contains: ${text}\n`);
      held = false;
    }
  }
  return held;
}

interface Captured {
  requests: number;
  tools: string[];
}

/** One turn: no tool call, just stop. The tool list is what is being collected. */
function serveLlm(captured: Captured) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        tools?: { function?: { name?: string } }[];
      };
      captured.requests += 1;
      for (const tool of body.tools ?? []) {
        const name = tool.function?.name;
        if (name) captured.tools.push(name);
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
}

async function probe(): Promise<number> {
  const atoma = process.env.ATOMA_BIN ?? "atoma";

  say("1. is the layout still the one the runner builds");
  const layoutHeld = await assertLayoutStillMatches();

  // ── the runner's two facts, reproduced ──────────────────────────────────────
  say("2. put the machinery where a run puts it");
  await Bun.$`rm -rf ${MACHINERY}`.quiet();
  await Bun.$`mkdir -p ${MACHINERY}`.quiet();
  await Bun.$`cp -r .github ${MACHINERY}/.github`.quiet();
  // The runner sets these on every run rather than trusting the checkout: the mode
  // is decided wherever the repository was committed from. `before_tool` is
  // fail-closed, so a hook that cannot start denies the tool outright.
  await Bun.$`chmod -R +x ${MACHINERY}/.github/atoma/tools/scripts/hooks`.quiet().nothrow();
  result("machinery_at", MACHINERY);

  const packages = (await Bun.file(`${MACHINERY}/.github/atoma/mcp-packages.json`).json()) as {
    npm?: string[];
    bun?: string[];
  };

  const npmPackages = packages.npm ?? [];
  if (npmPackages.length > 0) {
    // Executables a server is started by name. Global, so the name resolves.
    const installed = await Bun.$`npm install -g ${npmPackages}`.quiet().nothrow();
    const prefix = (await Bun.$`npm prefix -g`.text()).trim();
    process.env.PATH = `${prefix}/bin:${process.env.PATH ?? ""}`;
    result("npm_globals", npmPackages.join(" "));
    result("npm_install_exit", installed.exitCode);
    if (installed.exitCode !== 0) process.stdout.write(installed.stderr.toString());
  }

  const bunPackages = packages.bun ?? [];
  if (bunPackages.length > 0) {
    // Beside the machinery, which is the whole of #496: resolution walks up from
    // the importing file, so from `${RUNNER_TEMP}/atoma-machinery/...` it reaches
    // `${RUNNER_TEMP}` and stops. Not the work tree, ever.
    const manifest = Bun.file(`${RUNNER_TEMP}/package.json`);
    if (!(await manifest.exists())) {
      await Bun.write(manifest, `{"name":"atoma-mcp-libraries","private":true}\n`);
    }
    const added = await Bun.$`bun add --no-save ${bunPackages}`.cwd(RUNNER_TEMP).quiet().nothrow();
    result("bun_libraries", bunPackages.join(" "));
    result("bun_add_exit", added.exitCode);
    if (added.exitCode !== 0) process.stdout.write(added.stderr.toString());
  }
  result("node_modules_beside_machinery", existsSync(`${RUNNER_TEMP}/node_modules`));

  // ── every server the tools file declares ────────────────────────────────────
  say("3. the servers a run would start");
  const toolsYaml = Bun.YAML.parse(await Bun.file(TOOLS_FILE).text()) as Record<string, unknown>;
  const servers = Object.keys(toolsYaml);
  result("servers_declared", servers.join(" "));

  const dir = `${RUNNER_TEMP}/probe-tool-servers`;
  await Bun.$`rm -rf ${dir}`.quiet();
  await Bun.$`mkdir -p ${dir}`.quiet();
  // Every server in the file, not the union of the agent definitions: a server no
  // agent names today is still one this repository ships, and it will fail the
  // same way the day one does.
  await Bun.write(
    `${dir}/agent.md`,
    [
      "---",
      "name: probe",
      "description: Starts every tool server and does nothing with them.",
      "provider: openai",
      "model: probe-model",
      "mcp_servers:",
      ...servers.map((name) => `  - ${name}`),
      "---",
      "",
      "Say done.",
      "",
    ].join("\n"),
  );
  await Bun.write(`${dir}/prompt.txt`, "Say done.\n");

  const captured: Captured = { requests: 0, tools: [] };
  const llm = serveLlm(captured);

  const started = Bun.nanoseconds();
  const run = Bun.spawn(
    [atoma, "run", "--agent-def", `${dir}/agent.md`, "--tools-file", TOOLS_FILE, "--prompt-file", `${dir}/prompt.txt`, "--max-iterations", "2"],
    {
      env: {
        ...process.env,
        ATOMA_MACHINERY_ROOT: MACHINERY,
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
  const seconds = ((Bun.nanoseconds() - started) / 1e9).toFixed(1);

  result("atoma_exit", exit);
  result("run_seconds", seconds);
  result("llm_requests", captured.requests);
  result("tools_registered", captured.tools.length);

  say("4. which servers registered tools");
  let everyServerCameUp = true;
  for (const server of servers) {
    const count = captured.tools.filter((name) => name.startsWith(`${server}__`)).length;
    result(`tools_from_${server}`, count);
    if (count === 0) everyServerCameUp = false;
  }

  // Reported, not required: a server may say something at startup, and with
  // atoma#13 the line is classified rather than only logged. #499's reranker
  // failure is 60 seconds away from here, so its absence proves nothing.
  say("5. anything a server said about itself on the way up");
  const log = `${stdout}\n${stderr}`;
  const said = log
    .split("\n")
    .filter((line) => /MCP:[a-z_]+:(stderr|log)/.test(line))
    .filter((line) => /\b(warn|warning|warnings|error|errors|fatal|panic)\b/i.test(line));
  result("startup_reports", said.length);
  for (const line of said) process.stdout.write(`${line}\n`);

  say("6. verdict");
  const held = layoutHeld && exit === 0 && everyServerCameUp;
  result("every_server_came_up", everyServerCameUp);
  result("required_all_held", held);
  if (!held) {
    process.stdout.write(`\n--- atoma stdout ---\n${stdout}\n--- atoma stderr ---\n${stderr}\n`);
  }
  return held ? 0 : 1;
}

process.exit(await probe());

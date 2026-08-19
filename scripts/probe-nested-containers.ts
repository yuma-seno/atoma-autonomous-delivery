#!/usr/bin/env bun
/**
 * probe-nested-containers.ts — answer "do nested containers work inside the
 * confined shell" without an agent in the loop.
 *
 * Three verification runs asked an agent this question. The first two produced
 * exact, useful measurements. The third produced 822k tokens of text about
 * repositories that do not exist and a conclusion contradicting what the second
 * one had measured. The question is mechanical, so the answer should not depend on
 * a model staying on task for twenty minutes.
 *
 * Nothing here re-describes the confinement. It reads the real one:
 *
 *   the setup      the `run:` block of atoma-runner.yml's own confinement step,
 *                  executed as-is with bash
 *   the container  tools.yaml's `shell` entry, argv unchanged except for the
 *                  command at the end
 *
 * So there is no second copy to drift, and a probe that passes is evidence about
 * what agents actually get rather than about a reconstruction of it.
 *
 * Usage (inside a job that has podman, sudo and a checkout):
 *   bun run scripts/probe-nested-containers.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

const RUNNER_WORKFLOW = ".github/workflows/atoma-runner.yml";
const TOOLS_YAML = ".github/atoma/tools/tools.yaml";
const CONFINEMENT_STEP = "Confine the shell tool server";

/** What the probe runs INSIDE the confined container, in place of the tool server. */
const PROBE = [
  'echo "=== identity ==="',
  "id",
  'echo "PATH=$PATH"',
  "ls -l /home/runner/.local/bin/ || true",
  'echo "=== ids and capabilities ==="',
  "cat /etc/subuid /etc/subgid",
  "cat /proc/self/uid_map",
  "grep -E 'CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs' /proc/self/status",
  'echo "=== the entrypoint normally does this ==="',
  'mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"',
  'echo "=== 1. run a container ==="',
  "podman run --rm docker.io/library/alpine:latest echo ok; echo \"run rc=$?\"",
  'echo "=== 2. build an image ==="',
  "printf 'FROM docker.io/library/alpine:latest\\nRUN echo built > /x\\n' > /tmp/Dockerfile",
  'podman build -q -f /tmp/Dockerfile /tmp; echo "build rc=$?"',
  'echo "=== 3. what uid is inside ==="',
  'podman run --rm docker.io/library/alpine:latest id; echo "id rc=$?"',
  'echo "=== 4. reach the network from inside ==="',
  "podman run --rm docker.io/library/alpine:latest sh -c 'nslookup example.com >/dev/null 2>&1 && echo dns-ok'; echo \"dns rc=$?\"",
  'echo "=== 5. non-root users an image might declare ==="',
  'for u in 1000 65532 65534; do podman run --rm --user $u docker.io/library/alpine:latest id -u; echo "user $u rc=$?"; done',
  'echo "=== 6. the work tree is shared and writable ==="',
  'touch probe-wrote-this && ls -l probe-wrote-this && rm probe-wrote-this; echo "worktree rc=$?"',
  'echo "=== 7. what a nested container can reach of the host ==="',
  'podman run --rm -v /:/host:ro docker.io/library/alpine:latest sh -c \'id -u; head -c 40 /host/etc/hostname 2>&1 | head -1\'; echo "hostmount rc=$?"',
  'echo "=== debug tail, whatever happened above ==="',
  "podman --log-level=debug run --rm docker.io/library/alpine:latest echo ok 2>&1 | tail -25",
].join("\n");

interface WorkflowDocument {
  jobs?: Record<string, { steps?: { name?: string; run?: string }[] }>;
}

interface ToolEntry {
  command?: string;
  args?: string[];
}

function confinementScript(): string {
  const doc = Bun.YAML.parse(readFileSync(RUNNER_WORKFLOW, "utf8")) as WorkflowDocument;
  for (const job of Object.values(doc.jobs ?? {})) {
    const step = (job.steps ?? []).find((candidate) => candidate.name === CONFINEMENT_STEP);
    if (step?.run) return step.run;
  }
  throw new Error(`${RUNNER_WORKFLOW} has no step named "${CONFINEMENT_STEP}"`);
}

/**
 * Expand `${NAME}` from the environment, the way the tools file loader does.
 *
 * An unset name is left alone rather than emptied: `${PATH}` disappearing would
 * make the container look configured when it is not.
 */
function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => process.env[name] ?? whole);
}

function shellArgv(): string[] {
  const tools = Bun.YAML.parse(readFileSync(TOOLS_YAML, "utf8")) as Record<string, ToolEntry>;
  const shell = tools.shell;
  if (!shell?.command || !Array.isArray(shell.args)) throw new Error(`${TOOLS_YAML} has no usable shell entry`);

  const args = shell.args.map(expand);
  // The last two are `-c` and the tool server's own command line. Everything
  // before them is the confinement, and stays exactly as configured.
  const at = args.lastIndexOf("-c");
  if (at === -1 || at !== args.length - 2) {
    throw new Error(`the shell entry does not end in -c <command>; last args: ${args.slice(-3).join(" ")}`);
  }
  return [shell.command, ...args.slice(0, at + 1), PROBE];
}

function main(): void {
  const script = "/tmp/atoma-confinement-step.sh";
  writeFileSync(script, confinementScript());
  console.log(`--- running ${RUNNER_WORKFLOW}'s "${CONFINEMENT_STEP}" verbatim ---`);
  const setup = Bun.spawnSync({ cmd: ["bash", "-e", script], stdout: "inherit", stderr: "inherit" });
  if (setup.exitCode !== 0) {
    console.error(`::error::the confinement step failed with ${setup.exitCode}; nothing further can be measured`);
    process.exit(setup.exitCode ?? 1);
  }

  const argv = shellArgv();
  console.log(`--- running the shell container from ${TOOLS_YAML} ---`);
  console.log(argv.slice(0, -1).join(" "));
  const probe = Bun.spawnSync({ cmd: argv, stdout: "inherit", stderr: "inherit" });
  console.log(`--- container exited ${probe.exitCode} ---`);

  // The container's own exit code is the probe's last command, which is a debug
  // dump: it says nothing about whether the earlier steps worked. Read the output.
  process.exit(0);
}

if (import.meta.main) main();

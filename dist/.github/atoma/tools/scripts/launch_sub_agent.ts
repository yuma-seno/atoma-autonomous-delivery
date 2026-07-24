#!/usr/bin/env bun
// @bun

// src/atoma/tools/scripts/launch_sub_agent.ts
import { parseArgs } from "util";

// src/lib/gh.ts
function run(cmd) {
  const proc = Bun.spawnSync({
    cmd,
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "",
    stderr: proc.stderr ? proc.stderr.toString("utf8").trim() : ""
  };
}
function gh(...args) {
  return run(["gh", ...args]);
}

// src/lib/config.ts
import { readFileSync } from "fs";
var CONFIG_PATH = ".github/atoma/config.json";
var cached;
function loadConfig() {
  if (!cached) {
    cached = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  }
  return cached;
}
function getLabel(key, fallback) {
  return loadConfig().labels?.[key] ?? fallback;
}

// src/lib/ops-log.ts
import { appendFileSync } from "fs";
var OPS_LOG_PATH = process.env.ATOMA_OPS_LOG ?? "/tmp/atoma_ops.log";
function logOp(op, payload = {}) {
  const entry = { ts: new Date().toISOString(), op, ...payload };
  try {
    appendFileSync(OPS_LOG_PATH, JSON.stringify(entry) + `
`);
  } catch (e) {
    console.error(`[ops-log] WARN: failed to write op log: ${e}`);
  }
}
function logDispatch(target, agent, extra = {}) {
  logOp("dispatch", { target, agent, ...extra });
}

// src/atoma/tools/scripts/launch_sub_agent.ts
function dispatchSubAgent(issue, agent, notify = "") {
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error(`issue must be a positive integer, got: ${issue}`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) {
    throw new Error(`agent must be a valid lowercase agent name, got: ${agent}`);
  }
  console.error(`Dispatching agent '${agent}' on sub-issue #${issue} ...`);
  gh("issue", "comment", String(issue), "--body", `Atoma: Agent \`${agent}\` dispatched to work on this sub-task.`);
  const launchedLabel = getLabel("launched", "atoma/launched");
  const { code: labelCode } = gh("issue", "edit", String(issue), "--add-label", launchedLabel);
  if (labelCode !== 0) {
    console.error(`Warning: failed to add '${launchedLabel}' label to #${issue}`);
  }
  const dispatchWorkflow = process.env.ATOMA_DISPATCH_WORKFLOW || "atoma-runner.yml";
  gh("workflow", "run", dispatchWorkflow, "--field", `agent=${agent}`, "--field", `number=${issue}`, "--field", "type=issue", "--field", `notify=${notify}`);
  logDispatch("issue", agent, { number: issue });
  return { issue, agent };
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      agent: { type: "string" }
    }
  });
  if (!values.issue) {
    console.error("Error: --issue is required");
    process.exit(1);
  }
  if (!values.agent) {
    console.error("Error: --agent is required");
    process.exit(1);
  }
  if (!/^\d+$/.test(values.issue)) {
    console.error(`Error: --issue must be a positive integer, got: ${values.issue}`);
    process.exit(1);
  }
  try {
    const result = dispatchSubAgent(Number(values.issue), values.agent, process.env.ISSUE_NOTIFY ?? "");
    console.log(`dispatched: agent=${result.agent} issue=#${result.issue}`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
if (import.meta.main)
  main();
export {
  dispatchSubAgent
};

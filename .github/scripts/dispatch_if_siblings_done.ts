#!/usr/bin/env bun
// @bun

// src/scripts/dispatch_if_siblings_done.ts
import { parseArgs } from "util";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

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

// src/lib/sibling-check.ts
function countOpenSiblings(opts) {
  const label = opts.label || getLabel("sub_issue", "atoma/sub-issue");
  const launchedLabel = opts.launchedLabel || getLabel("launched", "atoma/launched");
  const { code, stdout, stderr } = gh("issue", "list", "--repo", opts.repo, "--state", "open", "--label", label, "--label", launchedLabel, "--search", `atoma:parent=#${opts.parent} in:body`, "--json", "number");
  if (code !== 0) {
    throw new Error(`countOpenSiblings: gh issue list failed: ${stderr}`);
  }
  const siblings = stdout ? JSON.parse(stdout) : [];
  const remaining = opts.exclude !== undefined ? siblings.filter((s) => s.number !== opts.exclude) : siblings;
  return remaining.length;
}

// src/lib/tags.ts
function makeTag(key, valuePattern, parse, render) {
  const re = new RegExp(`<!--\\s*atoma:${key}=(${valuePattern})\\s*-->`);
  return {
    write: (value) => `<!-- atoma:${key}=${render(value)} -->`,
    read: (text) => {
      const m = re.exec(text);
      return m ? parse(m[1]) : undefined;
    },
    has: (text) => re.test(text)
  };
}
function numericTag(key, hashPrefix) {
  return makeTag(key, "#?\\d+", (raw) => Number(raw.replace(/^#/, "")), (value) => `${hashPrefix ? "#" : ""}${value}`);
}
function stringTag(key, valuePattern) {
  return makeTag(key, valuePattern, (raw) => raw, (value) => value);
}
var PARENT_TAG = numericTag("parent", true);
var PARENT_ISSUE_TAG = numericTag("parent-issue", false);
var NOTIFY_TAG = stringTag("notify", "[A-Za-z0-9-]+");
var ORIGIN_AGENT_TAG = stringTag("origin-agent", "[a-z][a-z0-9-]*");
var DISPATCH_TAG = stringTag("dispatch", "[a-z][a-z0-9-]*");
var AGENT_TAG = stringTag("agent", "[a-z][a-z0-9-]*");
var AGGREGATED_TAG = numericTag("aggregated", false);
var SUB_RESULT_TAG = numericTag("sub-result", false);
function readAnyParentTag(text) {
  return PARENT_TAG.read(text) ?? PARENT_ISSUE_TAG.read(text);
}

// src/lib/notify.ts
var MAX_HOPS = 10;
function fetchIssueLookup(repo, number) {
  const { code, stdout } = gh("api", `repos/${repo}/issues/${number}`, "--jq", "{body: .body, login: .user.login, type: .user.type}");
  if (code !== 0 || !stdout.trim())
    return {};
  try {
    return JSON.parse(stdout);
  } catch {
    return {};
  }
}
function resolveNotify(repo, number) {
  const visited = new Set;
  let current = number;
  for (let i = 0;i < MAX_HOPS; i++) {
    if (visited.has(current))
      break;
    visited.add(current);
    const d = fetchIssueLookup(repo, current);
    const body = d.body ?? "";
    const tagged = NOTIFY_TAG.read(body);
    if (tagged)
      return tagged;
    if ((d.type ?? "").toLowerCase() === "user" && d.login) {
      return d.login;
    }
    const parent = readAnyParentTag(body);
    if (parent === undefined)
      break;
    current = parent;
  }
  return "";
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

// src/lib/aggregation.ts
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function dispatchOrchestratorIfReady(opts) {
  const excludeNum = opts.exclude ? opts.closedNum : undefined;
  let remaining = countOpenSiblings({ repo: opts.repo, parent: opts.parent, exclude: excludeNum });
  if (opts.retry) {
    for (let attempt = 1;remaining > 0 && attempt < 4; attempt++) {
      await sleep(2000 * attempt);
      remaining = countOpenSiblings({ repo: opts.repo, parent: opts.parent, exclude: excludeNum });
    }
  }
  if (remaining > 0) {
    if (opts.progressMessage) {
      gh("issue", "comment", String(opts.parent), "--repo", opts.repo, "--body", `${SUB_RESULT_TAG.write(opts.closedNum)}
${opts.progressMessage(remaining)}`);
    }
    return { ready: false, remaining, dispatched: false };
  }
  const { stdout: commentsOut } = gh("issue", "view", String(opts.parent), "--repo", opts.repo, "--json", "comments", "--jq", ".comments[].body");
  if (commentsOut.includes(AGGREGATED_TAG.write(opts.closedNum))) {
    return { ready: true, remaining: 0, dispatched: false };
  }
  if (opts.beforeDispatch)
    await opts.beforeDispatch();
  gh("issue", "comment", String(opts.parent), "--repo", opts.repo, "--body", `${AGGREGATED_TAG.write(opts.closedNum)}
Atoma: All sub-tasks completed (last: #${opts.closedNum}). Re-invoking orchestrator for aggregation.`);
  const notify = resolveNotify(opts.repo, opts.parent);
  gh("workflow", "run", opts.dispatchWorkflow ?? "atoma-runner.yml", "--repo", opts.repo, "--field", "agent=orchestrator", "--field", `number=${opts.parent}`, "--field", "type=issue", "--field", `notify=${notify}`);
  logDispatch("issue", "orchestrator", { number: opts.parent });
  return { ready: true, remaining: 0, dispatched: true };
}

// src/scripts/dispatch_if_siblings_done.ts
var ref = defineScript(import.meta.url);
async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      parent: { type: "string" },
      "closed-num": { type: "string" }
    }
  });
  if (!values.repo || !values.parent || !values["closed-num"]) {
    console.error("usage: dispatch_if_siblings_done.ts --repo OWNER/REPO --parent N --closed-num N");
    process.exit(2);
  }
  const { repo, parent } = values;
  const closedNum = values["closed-num"];
  console.log("Sub-issue closed manually. Checking open siblings...");
  const result = await dispatchOrchestratorIfReady({
    repo,
    parent: Number(parent),
    closedNum: Number(closedNum)
  });
  if (!result.ready) {
    console.log(`Still ${result.remaining} sibling(s) open. No action needed.`);
  } else if (!result.dispatched) {
    console.log(`Aggregation for #${closedNum} already dispatched by another caller; skipping.`);
  } else {
    console.log(`All siblings done. Dispatched orchestrator on parent #${parent}.`);
  }
}
if (import.meta.main)
  main();
export {
  ref
};

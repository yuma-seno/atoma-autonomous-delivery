#!/usr/bin/env bun
// @bun

// src/scripts/aggregate_sub_issues.ts
import { parseArgs } from "util";
import { dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";

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
function gitRun(...args) {
  return run(["git", ...args]);
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
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
var LLM_CONTEXT_TAG = stringTag("llm-context", "include|exclude");
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
      gh("issue", "comment", String(opts.parent), "--repo", opts.repo, "--body", `${LLM_CONTEXT_TAG.write("exclude")}
${SUB_RESULT_TAG.write(opts.closedNum)}
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

// src/lib/inject-sub-results.ts
function findLastToolIndex(messages) {
  for (let i = messages.length - 1;i >= 0; i--) {
    if (messages[i]?.role === "tool")
      return i;
  }
  return null;
}
function gatherSubResults(repo, subIssues) {
  const lines = ["All sub-issues have been completed.", "", "## Sub-issue Results", ""];
  for (const num of subIssues) {
    let title = "Unknown";
    let state = "closed";
    try {
      const { code, stdout } = gh("issue", "view", String(num), "--repo", repo, "--json", "title,state,closedAt");
      if (code === 0 && stdout) {
        const info = JSON.parse(stdout);
        title = info.title ?? "Unknown";
        state = info.state ?? "closed";
      }
    } catch {}
    const linkedPrs = [];
    for (const state_ of ["merged", "open"]) {
      try {
        const { code, stdout } = gh("pr", "list", "--repo", repo, "--state", state_, "--search", `#${num} in:body`, "--json", "number,title,url");
        if (code === 0 && stdout) {
          const prs = JSON.parse(stdout);
          for (const pr of prs) {
            linkedPrs.push(`- PR #${pr.number}: ${pr.title} (${pr.url})`);
          }
        }
      } catch {}
    }
    lines.push(`### #${num}: ${title}`);
    lines.push(`Status: ${state}`);
    if (linkedPrs.length) {
      lines.push("Linked PRs:");
      lines.push(...linkedPrs);
    } else {
      lines.push("No linked PRs found.");
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("All sub-issues are complete. Please review the results and aggregate them into a final summary.");
  return lines.join(`
`);
}
function injectSubResults(session, repo, subIssues) {
  const messages = session.messages ?? [];
  const lastToolIdx = findLastToolIndex(messages);
  const summary = gatherSubResults(repo, subIssues);
  if (lastToolIdx === null) {
    console.error("No tool message found in session. Appending as user message.");
    messages.push({ role: "user", content: summary });
  } else {
    messages[lastToolIdx].content = summary;
  }
  session.messages = messages;
  return session;
}

// src/scripts/aggregate_sub_issues.ts
var ref = defineScript(import.meta.url);
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function injectResultsIntoOrchestratorSession(repo, parent) {
  const { stdout: allSubsOut } = gh("issue", "list", "--repo", repo, "--state", "all", "--json", "number,title,body", "--jq", `[.[] | select(.body | contains("atoma:parent=#${parent}")) | .number] | join(",")`);
  const subIssues = allSubsOut.trim().split(",").filter(Boolean).map(Number);
  console.log(`All sub-issues for parent #${parent}: ${subIssues.join(",")}`);
  const sessionPath = `sessions/issue-${parent}-orchestrator.json`;
  gitRun("config", "user.email", "action@github.com");
  gitRun("config", "user.name", "GitHub Actions");
  let saved = false;
  for (let attempt = 1;attempt <= 5; attempt++) {
    if (gitRun("fetch", "origin", "atoma-data").code === 0) {
      gitRun("checkout", "-B", "atoma-data", "origin/atoma-data");
    } else {
      gitRun("checkout", "--orphan", "atoma-data");
      gitRun("rm", "-rf", ".");
    }
    const session = gitRun("cat-file", "-e", `HEAD:${sessionPath}`).code === 0 ? JSON.parse(gitRun("show", `HEAD:${sessionPath}`).stdout) : { messages: [] };
    const updated = injectSubResults(session, repo, subIssues);
    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, JSON.stringify(updated, null, 2));
    gitRun("add", sessionPath);
    if (gitRun("diff", "--cached", "--quiet").code === 0) {
      console.log("No changes to session; skipping commit.");
      saved = true;
      break;
    }
    gitRun("commit", "-m", `atoma: inject sub-issue results for parent #${parent}`);
    if (gitRun("push", "origin", "atoma-data").code === 0) {
      saved = true;
      break;
    }
    console.log(`Push attempt ${attempt} failed (concurrent push) -- resetting and retrying with a fresh pull...`);
    await sleep2(attempt * 2000);
  }
  if (!saved) {
    console.log(`::warning::Failed to save session to atoma-data:${sessionPath} after all retries.`);
  }
}
async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      parent: { type: "string" },
      "closed-num": { type: "string" }
    }
  });
  const repo = values.repo;
  const parent = values.parent;
  const closedNum = values["closed-num"];
  if (!repo || !parent || !closedNum) {
    console.error("usage: aggregate_sub_issues.ts --repo OWNER/REPO --parent N --closed-num N");
    process.exit(2);
  }
  console.log(`PR merged (sub-issue #${closedNum}, parent #${parent}). Checking siblings...`);
  const result = await dispatchOrchestratorIfReady({
    repo,
    parent: Number(parent),
    closedNum: Number(closedNum),
    exclude: true,
    progressMessage: (remaining) => `Atoma: Sub-task #${closedNum} completed. ${remaining} sub-task(s) still in progress.`,
    beforeDispatch: () => injectResultsIntoOrchestratorSession(repo, parent)
  });
  if (!result.ready) {
    console.log("Not all sub-tasks done yet.");
  } else if (!result.dispatched) {
    console.log(`Aggregation for sub-issue #${closedNum} already dispatched by another caller; skipping.`);
  } else {
    console.log("All sub-tasks completed! Orchestrator re-invoked.");
  }
}
if (import.meta.main)
  main();
export {
  ref
};

#!/usr/bin/env bun
// @bun

// src/scripts/aggregate_sub_issues.ts
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
function gitRun(...args) {
  return run(["git", ...args]);
}
function dispatchWorkflow(context, workflow, args = [], log = (m) => console.error(m)) {
  const { code, stdout, stderr } = gh("workflow", "run", workflow, ...args);
  if (code) {
    log(`${context}: WARN failed to dispatch ${workflow}: ${stderr || stdout}`);
    return false;
  }
  log(`${context}: dispatched ${workflow}`);
  return true;
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

// src/domain/merge-readiness.ts
var CI_WOULD_BE_WASTED = new Set([
  "not-open",
  "draft",
  "conflicting",
  "behind",
  "mergeability-unknown",
  "checks-pending",
  "checks-failing"
]);
var PASSING = new Set(["success", "neutral", "skipped"]);

// src/domain/auto-triggers.ts
var TRIGGER_CONDITIONS = {
  changes_requested: "runtime",
  non_draft: "runtime",
  "atoma:dispatch": "elsewhere"
};
var KNOWN = Object.keys(TRIGGER_CONDITIONS).sort();

// src/lib/config.ts
function configPath() {
  const root = process.env.ATOMA_MACHINERY_ROOT?.trim();
  return root ? `${root}/.github/atoma/config.json` : ".github/atoma/config.json";
}
var cached;
function loadConfig() {
  if (!cached) {
    cached = JSON.parse(readFileSync(configPath(), "utf8"));
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
  const { code, stdout, stderr } = gh("issue", "list", "--repo", opts.repo, "--state", "open", "--label", label, "--label", launchedLabel, "--search", `atoma:parent=${opts.parent} in:body`, "--json", "number");
  if (code !== 0) {
    throw new Error(`countOpenSiblings: gh issue list failed: ${stderr}`);
  }
  const siblings = stdout ? JSON.parse(stdout) : [];
  const remaining = opts.exclude !== undefined ? siblings.filter((s) => s.number !== opts.exclude) : siblings;
  return remaining.length;
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

// src/lib/dispatch.ts
function runnerWorkflow() {
  return process.env.ATOMA_DISPATCH_WORKFLOW || "atoma-runner.yml";
}
function dispatchRunner(d) {
  const args = [
    ...d.repo ? ["--repo", d.repo] : [],
    "--field",
    `agent=${d.agent}`,
    "--field",
    `number=${d.number}`,
    "--field",
    `type=${d.type}`,
    "--field",
    `notify=${d.notify ?? ""}`
  ];
  if (!dispatchWorkflow(d.context, runnerWorkflow(), args, d.log))
    return false;
  logDispatch(d.type, d.agent, { number: Number(d.number) });
  return true;
}

// src/lib/agent-name.ts
var AGENT_NAME_PATTERN = "[a-z][a-z0-9-]*";
var AGENT_NAME_RE = new RegExp(`^${AGENT_NAME_PATTERN}$`);

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
function numericTag(key) {
  return makeTag(key, "\\d+", Number, String);
}
function stringTag(key, valuePattern) {
  return makeTag(key, valuePattern, (raw) => raw, (value) => value);
}
var PARENT_TAG = numericTag("parent");
var PARENT_ISSUE_TAG = numericTag("parent-issue");
var NOTIFY_TAG = stringTag("notify", "[A-Za-z0-9-]+");
var ORIGIN_AGENT_TAG = stringTag("origin-agent", AGENT_NAME_PATTERN);
var DISPATCH_TAG = stringTag("dispatch", AGENT_NAME_PATTERN);
var AGENT_TAG = stringTag("agent", AGENT_NAME_PATTERN);
var LLM_CONTEXT_TAG = stringTag("llm-context", "include|exclude");
var AGGREGATED_TAG = numericTag("aggregated");
var SUB_RESULT_TAG = numericTag("sub-result");
var CI_RETRY_TAG = numericTag("ci-retry");
function readAnyParentTag(text) {
  return PARENT_TAG.read(text) ?? PARENT_ISSUE_TAG.read(text);
}

// src/lib/notify.ts
function log(message) {
  console.error(`[atoma-notify] ${message}`);
}
var MAX_HOPS = 10;
function fetchIssueLookup(repo, number) {
  const { code, stderr, stdout } = gh("api", `repos/${repo}/issues/${number}`, "--jq", "{body: .body, login: .user.login, type: .user.type}");
  if (code !== 0 || !stdout.trim()) {
    log(`WARN could not read issue #${number} to resolve a mention: ${stderr.trim() || `gh exited ${code}`}`);
    return {};
  }
  try {
    return JSON.parse(stdout);
  } catch {
    log(`WARN issue #${number} lookup was not valid JSON; no mention will be resolved from it`);
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

// src/lib/aggregation.ts
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function needsAttention(result) {
  return result.kind === "dispatch-failed" || result.kind === "undetermined";
}
function describeGateResult(result, closedNum, parent) {
  const which = parent === undefined ? "the parent issue" : `#${parent}`;
  switch (result.kind) {
    case "not-tracked":
      return `#${closedNum} is not a tracked sub-issue; nothing to aggregate.`;
    case "waiting":
      return `${result.remaining} sibling(s) of ${which} still open. No action needed.`;
    case "already-aggregated":
      return `Another caller already aggregated #${closedNum}. Nothing to do -- this is the normal race.`;
    case "dispatched":
      return `All sub-tasks of ${which} complete. Orchestrator re-invoked.`;
    case "dispatch-failed":
      return `All sub-tasks of ${which} complete, but the orchestrator dispatch FAILED. ` + `The aggregation marker is already written, so no other caller will retry: ` + `re-run the orchestrator by hand.`;
    case "undetermined":
      return `Did not aggregate #${closedNum}: ${result.why}. Nothing was dispatched, and nothing will retry.`;
  }
}
async function dispatchOrchestratorIfReady(opts) {
  const excludeNum = opts.exclude ? opts.closedNum : undefined;
  const count = () => countOpenSiblings({ repo: opts.repo, parent: opts.parent, exclude: excludeNum });
  let remaining;
  try {
    remaining = count();
    if (opts.retry) {
      for (let attempt = 1;remaining > 0 && attempt < 4; attempt++) {
        await sleep(2000 * attempt);
        remaining = count();
      }
    }
  } catch (error) {
    const why = `could not count #${opts.parent}'s open sub-issues: ${error.message}`;
    console.error(why);
    return { kind: "undetermined", why };
  }
  if (remaining > 0) {
    if (opts.progressMessage) {
      gh("issue", "comment", String(opts.parent), "--repo", opts.repo, "--body", `${LLM_CONTEXT_TAG.write("exclude")}
${SUB_RESULT_TAG.write(opts.closedNum)}
${opts.progressMessage(remaining)}`);
    }
    return { kind: "waiting", remaining };
  }
  const { code: commentsCode, stdout: commentsOut } = gh("issue", "view", String(opts.parent), "--repo", opts.repo, "--json", "comments", "--jq", ".comments[].body");
  if (commentsCode !== 0) {
    const why = `could not read #${opts.parent}'s comments, so this cannot tell whether the aggregation already ran`;
    console.error(`${why}; not dispatching`);
    return { kind: "undetermined", why };
  }
  if (commentsOut.includes(AGGREGATED_TAG.write(opts.closedNum))) {
    return { kind: "already-aggregated" };
  }
  if (opts.beforeDispatch)
    await opts.beforeDispatch();
  const marker = gh("issue", "comment", String(opts.parent), "--repo", opts.repo, "--body", `${AGGREGATED_TAG.write(opts.closedNum)}
Atoma: All sub-tasks completed (last: #${opts.closedNum}). Re-invoking orchestrator for aggregation.`);
  if (marker.code !== 0) {
    const why = `could not write the aggregation marker on #${opts.parent}: ${marker.stderr.trim() || marker.stdout.trim()}`;
    console.error(`${why}; not dispatching, because without the marker a second caller would dispatch too`);
    return { kind: "undetermined", why };
  }
  const dispatched = dispatchRunner({
    context: `dispatchOrchestratorIfReady: re-invoking orchestrator on #${opts.parent}`,
    agent: "orchestrator",
    type: "issue",
    number: opts.parent,
    notify: resolveNotify(opts.repo, opts.parent),
    repo: opts.repo
  });
  return dispatched ? { kind: "dispatched" } : { kind: "dispatch-failed" };
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
    let state = "could not be read";
    try {
      const { code, stdout } = gh("issue", "view", String(num), "--repo", repo, "--json", "title,state,closedAt");
      if (code === 0 && stdout) {
        const info = JSON.parse(stdout);
        title = info.title ?? "Unknown";
        state = info.state ?? "could not be read";
      }
    } catch {}
    const linkedPrs = [];
    let prLookupFailed = false;
    for (const state_ of ["merged", "open"]) {
      try {
        const { code, stdout } = gh("pr", "list", "--repo", repo, "--state", state_, "--search", `#${num} in:body`, "--json", "number,title,url");
        if (code === 0 && stdout) {
          const prs = JSON.parse(stdout);
          for (const pr of prs) {
            linkedPrs.push(`- PR #${pr.number}: ${pr.title} (${pr.url})`);
          }
        } else {
          prLookupFailed = true;
        }
      } catch {
        prLookupFailed = true;
      }
    }
    lines.push(`### #${num}: ${title}`);
    lines.push(`Status: ${state}`);
    if (linkedPrs.length) {
      lines.push("Linked PRs:");
      lines.push(...linkedPrs);
    } else if (prLookupFailed) {
      lines.push("Linked PRs could not be read.");
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
function injectSummary(session, summary) {
  const messages = session.messages ?? [];
  const lastToolIdx = findLastToolIndex(messages);
  if (lastToolIdx === null) {
    console.error("No tool message found in session. Appending as user message.");
    messages.push({ role: "user", content: summary });
  } else {
    messages[lastToolIdx].content = summary;
  }
  session.messages = messages;
  return session;
}

// src/scripts/lib/atoma-data.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
function sessionTargetPath(type, number, agent) {
  return `sessions/${type}-${number}/${agent}.json`;
}
function restoreSession(targetPath) {
  if (gitRun("fetch", "origin", "atoma-data", "--depth=1").code !== 0) {
    return;
  }
  if (gitRun("cat-file", "-e", `origin/atoma-data:${targetPath}`).code !== 0) {
    return;
  }
  const shown = gitRun("show", `origin/atoma-data:${targetPath}`);
  return shown.code === 0 ? shown.stdout : undefined;
}
function gitIn(cwd, ...args) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "" };
}
function saveSession(targetPath, content, commitMessage) {
  if (gitRun("ls-remote", "--exit-code", "origin", "atoma-data").code !== 0) {
    gitRun("config", "user.email", "action@github.com");
    gitRun("config", "user.name", "GitHub Actions");
    const commit = gitRun("commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "init: atoma-data session store").stdout;
    gitRun("push", "origin", `${commit}:refs/heads/atoma-data`);
  }
  gitRun("fetch", "origin", "atoma-data");
  const worktreeDir = mkdtempSync(join(tmpdir(), "atoma-data-wt-"));
  gitRun("worktree", "add", worktreeDir, "origin/atoma-data");
  let saved = false;
  try {
    gitIn(worktreeDir, "config", "user.email", "action@github.com");
    gitIn(worktreeDir, "config", "user.name", "GitHub Actions");
    for (let attempt = 1;attempt <= 5; attempt++) {
      gitIn(worktreeDir, "fetch", "origin", "atoma-data");
      gitIn(worktreeDir, "reset", "--hard", "origin/atoma-data");
      const fullTarget = join(worktreeDir, targetPath);
      mkdirSync(dirname(fullTarget), { recursive: true });
      writeFileSync(fullTarget, content);
      gitIn(worktreeDir, "add", targetPath);
      if (gitIn(worktreeDir, "diff", "--cached", "--quiet").code === 0) {
        saved = true;
        break;
      }
      gitIn(worktreeDir, "commit", "-m", commitMessage);
      if (gitIn(worktreeDir, "push", "origin", "HEAD:atoma-data").code === 0) {
        saved = true;
        break;
      }
      console.error(`Push attempt ${attempt} failed (concurrent push) -- resetting and retrying with a fresh pull...`);
      Bun.sleepSync(attempt * 2000);
    }
  } finally {
    gitRun("worktree", "remove", "--force", worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  }
  return saved;
}

// src/scripts/aggregate_sub_issues.ts
var ref = defineScript(import.meta.url);
function linkedSubIssues(repo, parent) {
  const { code, stdout, stderr } = gh("issue", "list", "--repo", repo, "--state", "all", "--limit", "200", "--search", `atoma:parent=${parent} in:body`, "--json", "number,body");
  if (code !== 0) {
    throw new Error(`could not list sub-issues of #${parent}: ${stderr || stdout}`);
  }
  const issues = stdout ? JSON.parse(stdout) : [];
  return issues.filter((issue) => PARENT_TAG.read(issue.body ?? "") === parent).map((issue) => issue.number);
}
function injectResultsIntoOrchestratorSession(repo, parent) {
  const subIssues = linkedSubIssues(repo, parent);
  console.error(`Sub-issues of #${parent}: ${subIssues.join(", ") || "(none)"}`);
  const sessionPath = sessionTargetPath("issue", parent, "orchestrator");
  const existing = restoreSession(sessionPath);
  const session = existing ? JSON.parse(existing) : { messages: [] };
  const updated = injectSummary(session, gatherSubResults(repo, subIssues));
  const message = `atoma: inject sub-issue results for parent #${parent}`;
  if (!saveSession(sessionPath, JSON.stringify(updated, null, 2), message)) {
    console.error(`::warning::Failed to save session to atoma-data:${sessionPath} after all retries.`);
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
  console.error(`PR merged (sub-issue #${closedNum}, parent #${parent}). Checking siblings...`);
  const result = await dispatchOrchestratorIfReady({
    repo,
    parent: Number(parent),
    closedNum: Number(closedNum),
    exclude: true,
    progressMessage: (remaining) => `Atoma: Sub-task #${closedNum} completed. ${remaining} sub-task(s) still in progress.`,
    beforeDispatch: () => injectResultsIntoOrchestratorSession(repo, Number(parent))
  });
  console.error(describeGateResult(result, Number(closedNum), Number(parent)));
  if (needsAttention(result))
    process.exit(1);
}
if (import.meta.main)
  main();
export {
  ref
};

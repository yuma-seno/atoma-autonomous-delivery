#!/usr/bin/env bun
// @bun

// src/scripts/manage_dispatch_loop.ts
import { appendFileSync } from "fs";
import { parseArgs } from "util";

// src/domain/dispatch-chain.ts
var DEFAULT_HANDOFF_LIMIT = 5;
function isPerson(comment) {
  return comment.authorType === "User";
}
function handoffsSincePerson(comments, isAgentComment) {
  let handoffs = 0;
  for (let i = comments.length - 1;i >= 0; i--) {
    const comment = comments[i];
    if (isPerson(comment))
      break;
    if (isAgentComment(comment.body ?? ""))
      handoffs++;
  }
  return handoffs;
}
function resolveHandoffLimit(configured) {
  const value = typeof configured === "number" ? configured : Number(configured);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_HANDOFF_LIMIT;
}

// src/domain/progress.ts
var DEFAULT_NO_PROGRESS_LIMIT = 2;
function runsWithoutChange(comments, isNoChangeResult) {
  let runs = 0;
  for (let i = comments.length - 1;i >= 0; i--) {
    if (!isNoChangeResult(comments[i]?.body ?? ""))
      break;
    runs++;
  }
  return runs;
}
function noProgressLimitReached(runs, limit) {
  return runs >= limit;
}
function resolveNoProgressLimit(configured) {
  const value = Number(configured);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_NO_PROGRESS_LIMIT;
}
function stopReason(counts) {
  if (noProgressLimitReached(counts.runsWithoutChange, counts.noProgressLimit)) {
    return {
      stop: true,
      reason: `The last ${counts.runsWithoutChange} agent runs changed nothing \u2014 no commit was pushed by any of them ` + `(limit ${counts.noProgressLimit}). Repeating a run that changes nothing is unlikely to start changing something, ` + `so the next automatic handoff has been withheld.`
    };
  }
  if (counts.handoffs >= counts.handoffLimit) {
    return {
      stop: true,
      reason: `Auto-dispatch loop limit reached: ${counts.handoffs} agent handoffs since anyone else commented ` + `(limit ${counts.handoffLimit}). To prevent unintended infinite agent loops and excessive API costs, ` + `the next automatic handoff has been withheld.`
    };
  }
  return { stop: false };
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
function getHandoffLimit() {
  return loadConfig().limits?.agent_handoffs;
}
function getNoProgressLimit() {
  return loadConfig().limits?.runs_without_change;
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
var STOP_TAG = stringTag("stop", "requested");
var PARENT_TAG = numericTag("parent");
var PARENT_ISSUE_TAG = numericTag("parent-issue");
var NOTIFY_TAG = stringTag("notify", "[A-Za-z0-9-]+");
var ORIGIN_AGENT_TAG = stringTag("origin-agent", AGENT_NAME_PATTERN);
var DISPATCH_TAG = stringTag("dispatch", AGENT_NAME_PATTERN);
var AGENT_TAG = stringTag("agent", AGENT_NAME_PATTERN);
var CHANGED_TAG = stringTag("changed", "yes|no");
var LLM_CONTEXT_TAG = stringTag("llm-context", "include|exclude");
var AGGREGATED_TAG = numericTag("aggregated");
var SUB_RESULT_TAG = numericTag("sub-result");
var CI_RETRY_TAG = numericTag("ci-retry");

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/manage_dispatch_loop.ts
var ref = defineScript(import.meta.url);
function readComments(repo, number) {
  const { code, stdout } = gh("api", `repos/${repo}/issues/${number}/comments?per_page=100`, "--paginate", "--jq", ".[] | {authorType: .user.type, body: .body}");
  if (code)
    return { comments: [], read: false };
  const comments = [];
  for (const line of stdout.split(`
`)) {
    if (!line.trim())
      continue;
    try {
      comments.push(JSON.parse(line));
    } catch {
      console.error(`  Skipping an unparseable comment line`);
    }
  }
  return { comments, read: true };
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      repo: { type: "string" }
    }
  });
  const number = values.number ?? "";
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!number || !repo) {
    console.error("usage: manage_dispatch_loop.ts --number N [--repo owner/name]");
    process.exit(2);
  }
  const limit = resolveHandoffLimit(getHandoffLimit());
  const noProgressLimit = resolveNoProgressLimit(getNoProgressLimit());
  const { comments, read } = readComments(repo, number);
  if (!read)
    console.error(`WARN could not read comments on ${repo}#${number}; treating the chain as fresh`);
  const handoffs = handoffsSincePerson(comments, (body) => AGENT_TAG.has(body));
  const stalled = runsWithoutChange(comments, (body) => AGENT_TAG.has(body) && CHANGED_TAG.read(body) === "no");
  const decision = stopReason({
    handoffs,
    handoffLimit: limit,
    runsWithoutChange: stalled,
    noProgressLimit
  });
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `auto_dispatch_count=${handoffs}
` + `loop_limit_reached=${decision.stop}
` + `handoff_limit=${limit}
` + `runs_without_change=${stalled}
` + `stop_reason=${decision.reason ?? ""}
`);
  }
  console.error(`Agent handoffs since a person last commented: ${handoffs}/${limit}; ` + `consecutive runs that changed nothing: ${stalled}/${noProgressLimit} (stop=${decision.stop})`);
}
if (import.meta.main)
  main();
export {
  ref
};

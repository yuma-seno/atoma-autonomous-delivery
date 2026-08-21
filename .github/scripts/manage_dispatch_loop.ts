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
function handoffLimitReached(handoffs, limit) {
  return handoffs >= limit;
}
function resolveHandoffLimit(configured) {
  const value = typeof configured === "number" ? configured : Number(configured);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_HANDOFF_LIMIT;
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
  changes_requested: {
    kind: "runtime",
    matches: (context) => context.reviewState === "changes_requested"
  },
  non_draft: {
    kind: "runtime",
    matches: (context) => context.isDraft !== true
  },
  "atoma:dispatch": {
    kind: "elsewhere",
    matches: () => false
  }
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
function getHandoffLimit() {
  return loadConfig().limits?.agent_handoffs;
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
  const { comments, read } = readComments(repo, number);
  if (!read)
    console.error(`WARN could not read comments on ${repo}#${number}; treating the chain as fresh`);
  const handoffs = handoffsSincePerson(comments, (body) => AGENT_TAG.has(body));
  const reached = handoffLimitReached(handoffs, limit);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `auto_dispatch_count=${handoffs}
loop_limit_reached=${reached}
handoff_limit=${limit}
`);
  }
  console.error(`Agent handoffs since a person last commented: ${handoffs}/${limit} (limit_reached=${reached})`);
}
if (import.meta.main)
  main();
export {
  ref
};

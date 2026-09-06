#!/usr/bin/env bun
// @bun

// src/scripts/guard_comment_during_run.ts
import { appendFileSync } from "fs";
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
var DEFAULT_LABELS = {
  sub_issue: "atoma/sub-issue",
  launched: "atoma/launched",
  in_progress: "atoma/in-progress"
};
function getLabel(key) {
  return loadConfig().labels?.[key] ?? DEFAULT_LABELS[key];
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

// src/scripts/guard_comment_during_run.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      "comment-id": { type: "string" },
      commenter: { type: "string" }
    }
  });
  if (!values.number || !values["comment-id"]) {
    console.error("usage: guard_comment_during_run.ts --number N --comment-id ID --commenter LOGIN");
    process.exit(2);
  }
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const label = getLabel("in_progress");
  const githubOutput = process.env.GITHUB_OUTPUT;
  const { code, stdout } = gh("issue", "view", String(values.number), "--repo", repo, "--json", "labels", "--jq", `([.labels[].name] | index("${label}")) != null`);
  if (code !== 0) {
    console.error(`Could not read the labels on #${values.number}, so this cannot tell whether a run is in progress.`);
    process.exit(1);
  }
  const inProgress = stdout.trim() === "true";
  if (!inProgress) {
    if (githubOutput)
      appendFileSync(githubOutput, `blocked=false
`);
    return;
  }
  const { code: delCode, stdout: delOut, stderr: delErr } = gh("api", "--method", "DELETE", `repos/${repo}/issues/comments/${values["comment-id"]}`);
  const deleted = delCode === 0;
  if (!deleted) {
    console.error(`Warning: failed to delete comment #${values["comment-id"]} on #${values.number}: ${delErr || delOut}`);
  }
  const mention = values.commenter ? `@${values.commenter} ` : "";
  const what = deleted ? "Your comment was removed because" : "Your comment could not be removed, and will not be acted on, because";
  gh("issue", "comment", String(values.number), "--repo", repo, "--body", [
    LLM_CONTEXT_TAG.write("exclude"),
    `${mention}${what} Atoma is currently processing this issue/PR (the \`${label}\` label is active). Please wait for the current run to finish, then comment again.`
  ].join(`
`));
  if (githubOutput)
    appendFileSync(githubOutput, `blocked=true
`);
  console.error(`Deleted comment #${values["comment-id"]} on #${values.number} (in-progress guard) and notified ${values.commenter || "(unknown)"}.`);
}
if (import.meta.main)
  main();
export {
  ref
};

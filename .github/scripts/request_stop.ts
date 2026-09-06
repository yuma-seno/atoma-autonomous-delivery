#!/usr/bin/env bun
// @bun

// src/scripts/request_stop.ts
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

// src/scripts/request_stop.ts
var ref = defineScript(import.meta.url);
function runningChildren(repo, parent) {
  const label = getLabel("in_progress");
  const { code, stdout } = gh("issue", "list", "--repo", repo, "--state", "open", "--limit", "200", "--search", `atoma:parent=${parent} in:body`, "--label", label, "--json", "number,body");
  if (code !== 0)
    return [];
  try {
    const issues = JSON.parse(stdout || "[]");
    return issues.filter((i) => PARENT_TAG.read(i.body ?? "") === parent).map((i) => i.number);
  } catch {
    return [];
  }
}
function stopRequestedNotice(commenter, deleted, children) {
  const mention = commenter ? `@${commenter} ` : "";
  const lines = [
    LLM_CONTEXT_TAG.write("exclude"),
    STOP_TAG.write("requested"),
    `${mention}Atoma: stop requested.`,
    "",
    deleted ? "Your `/stop` comment was removed so it does not become part of the agent's context." : "Your `/stop` comment could not be removed, so it may end up in the agent's context.",
    "",
    "The run will stop after its current step, so it may take a minute. Nothing is lost when it does: the session is saved and can be continued."
  ];
  if (children.length > 0) {
    lines.push("", `This issue also has work running on ${children.map((n) => `#${n}`).join(", ")}. ` + "A stop here does not reach those \u2014 comment `/stop` on each one you want stopped.");
  }
  return lines.join(`
`);
}
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
    console.error("usage: request_stop.ts --number N --comment-id ID --commenter LOGIN");
    process.exit(2);
  }
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const number = String(values.number);
  const { code: delCode, stdout: delOut, stderr: delErr } = gh("api", "--method", "DELETE", `repos/${repo}/issues/comments/${values["comment-id"]}`);
  const deleted = delCode === 0;
  if (!deleted) {
    console.error(`Warning: failed to delete comment #${values["comment-id"]} on #${number}: ${delErr || delOut}`);
  }
  const children = runningChildren(repo, Number(number));
  const { code, stdout, stderr } = gh("issue", "comment", number, "--repo", repo, "--body", stopRequestedNotice(values.commenter ?? "", deleted, children));
  if (code !== 0) {
    console.error(`Could not post the stop request on #${number}: ${stderr || stdout}`);
    process.exit(1);
  }
  console.error(`Stop requested on #${number}${children.length ? ` (children running: ${children.join(", ")})` : ""}`);
}
if (import.meta.main)
  main();
export {
  ref,
  stopRequestedNotice
};

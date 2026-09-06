#!/usr/bin/env bun
// @bun

// src/scripts/watch_for_stop.ts
import { writeFileSync } from "fs";
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

// src/scripts/watch_for_stop.ts
var ref = defineScript(import.meta.url);
var DEFAULT_INTERVAL_SECONDS = 30;
function stopRequested(comments, since) {
  return comments.some((c) => {
    if (!STOP_TAG.has(c.body ?? ""))
      return false;
    const at = c.created_at ? Date.parse(c.created_at) : NaN;
    return Number.isNaN(at) || at > since.getTime();
  });
}
function poll(repo, number, since) {
  const { code, stdout } = gh("api", `repos/${repo}/issues/${number}/comments`, "--method", "GET", "-f", `since=${since.toISOString()}`, "--jq", "[.[] | {body, created_at}]");
  if (code !== 0)
    return false;
  try {
    return stopRequested(JSON.parse(stdout || "[]"), since);
  } catch {
    return false;
  }
}
async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      "stop-file": { type: "string" },
      since: { type: "string" },
      "interval-seconds": { type: "string" }
    }
  });
  if (!values.number || !values["stop-file"] || !values.since) {
    console.error("usage: watch_for_stop.ts --number N --stop-file PATH --since ISO8601");
    process.exit(2);
  }
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const since = new Date(values.since);
  const intervalMs = (Number(values["interval-seconds"]) || DEFAULT_INTERVAL_SECONDS) * 1000;
  console.error(`Watching #${values.number} for a stop request since ${since.toISOString()}`);
  for (;; ) {
    await Bun.sleep(intervalMs);
    if (!poll(repo, String(values.number), since))
      continue;
    writeFileSync(values["stop-file"], `stop requested on #${values.number}
`);
    console.error(`Stop request found; wrote ${values["stop-file"]}`);
    return;
  }
}
if (import.meta.main)
  await main();
export {
  ref,
  stopRequested
};

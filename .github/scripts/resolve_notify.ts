#!/usr/bin/env bun
// @bun

// src/scripts/resolve_notify.ts
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

// src/scripts/resolve_notify.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      number: { type: "string" }
    }
  });
  if (!values.repo || !values.number) {
    console.error("usage: resolve_notify.ts --repo OWNER/REPO --number N");
    process.exit(2);
  }
  console.log(resolveNotify(values.repo, Number(values.number)));
}
if (import.meta.main)
  main();
export {
  ref
};

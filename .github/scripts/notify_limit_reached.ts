#!/usr/bin/env bun
// @bun

// src/scripts/notify_limit_reached.ts
import { existsSync, readFileSync } from "fs";
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

// src/domain/tool-tally.ts
var NAMED = 4;
function toolCallTally(session) {
  const names = [];
  for (const message of session?.messages ?? []) {
    for (const call of message.tool_calls ?? []) {
      const name = call.function?.name;
      if (typeof name === "string" && name !== "")
        names.push(name);
    }
  }
  if (names.length === 0)
    return;
  const counts = new Map;
  for (const name of names)
    counts.set(name, (counts.get(name) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked.slice(0, NAMED).map(([name, n]) => `\`${name}\` ${n}`);
  const rest = ranked.slice(NAMED);
  if (rest.length > 0) {
    const restCalls = rest.reduce((sum, [, n]) => sum + n, 0);
    shown.push(`and ${rest.length} other tool${rest.length === 1 ? "" : "s"} ${restCalls}`);
  }
  return `Spent on: ${names.length} tool calls \u2014 ${shown.join(", ")}.`;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/notify_limit_reached.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      agent: { type: "string" },
      notify: { type: "string" },
      session: { type: "string" }
    }
  });
  if (!values.number || !values.agent) {
    console.error("usage: notify_limit_reached.ts --number N --agent AGENT [--notify LOGIN]");
    process.exit(2);
  }
  const notice = values.notify ? `@${values.notify} Atoma: \`${values.agent}\` ran out of time. Review the issue and comment \`/${values.agent}\` to retry.` : `Atoma: \`${values.agent}\` ran out of time. Comment \`/${values.agent}\` to retry.`;
  const spent = toolCallTally(readSession(values.session));
  gh("issue", "comment", values.number, "--body", [`${LLM_CONTEXT_TAG.write("exclude")}`, notice, ...spent ? ["", spent] : []].join(`
`));
}
function readSession(path) {
  if (!path || !existsSync(path))
    return;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
}
if (import.meta.main)
  main();
export {
  ref
};

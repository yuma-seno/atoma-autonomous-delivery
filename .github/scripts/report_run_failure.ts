#!/usr/bin/env bun
// @bun

// src/scripts/report_run_failure.ts
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

// src/domain/redaction.ts
var PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
];
var REDACTED = "[redacted]";
function redact(text, literals = []) {
  let out = text;
  for (const literal of literals)
    out = out.split(literal).join(REDACTED);
  for (const pattern of PATTERNS)
    out = out.replace(pattern, REDACTED);
  return out;
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

// src/scripts/report_run_failure.ts
var ref = defineScript(import.meta.url);
var INTERESTING = /error|fail|panic|exception|unauthorized/i;
var EXCERPT_LINES = 5;
function logExcerpt(text) {
  return text.split(`
`).filter((line) => INTERESTING.test(line)).slice(0, EXCERPT_LINES).map((line) => redact(line)).join(`
`).trim();
}
function failureNotice(agent, notify, runUrl, excerpt) {
  const mention = notify ? `@${notify} ` : "";
  const lines = [
    LLM_CONTEXT_TAG.write("exclude"),
    `${mention}Atoma: \`${agent}\` did not finish \u2014 the run failed.`,
    "",
    "**The session was saved.** What this run worked out is still there.",
    "",
    `- Continue: comment \`/${agent}\` and put what to do next on the following lines.`,
    `- Start clean: comment \`/${agent} recover\`, which archives this session and rebuilds`,
    "  it from the issue.",
    "",
    `Workflow logs: ${runUrl}`
  ];
  if (excerpt) {
    lines.push("", "From the log, which is often about the infrastructure rather than the work:", "```", excerpt, "```");
  }
  return lines.join(`
`);
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      agent: { type: "string" },
      notify: { type: "string" },
      "run-url": { type: "string" },
      "logs-file": { type: "string" }
    }
  });
  if (!values.number) {
    console.error("::error::Cannot post failure comment: issue/PR number unknown.");
    return;
  }
  let excerpt = "";
  const logs = values["logs-file"];
  if (logs && existsSync(logs)) {
    try {
      excerpt = logExcerpt(readFileSync(logs, "utf8"));
    } catch {
      excerpt = "";
    }
  }
  const body = failureNotice(values.agent ?? "", values.notify, values["run-url"] ?? "", excerpt);
  const { code, stdout, stderr } = gh("issue", "comment", String(values.number), "--body", body);
  if (code !== 0)
    console.error(`Failed to post the failure comment: ${stderr || stdout}`);
}
if (import.meta.main)
  main();
export {
  failureNotice,
  logExcerpt,
  ref
};

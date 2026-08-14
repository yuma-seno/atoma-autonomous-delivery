#!/usr/bin/env bun
// @bun

// src/scripts/parse_pr_metadata.ts
import { appendFileSync } from "fs";

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

// src/scripts/parse_pr_metadata.ts
var ref = defineScript(import.meta.url);
function main() {
  const body = process.env.PR_BODY ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const githubOutput = process.env.GITHUB_OUTPUT;
  const parentIssue = PARENT_ISSUE_TAG.read(body);
  const parent = parentIssue === undefined ? "" : String(parentIssue);
  if (parent)
    console.error(`PR #${prNumber} is linked to parent issue #${parent}`);
  else
    console.error(`PR #${prNumber} has no parent-issue metadata`);
  const sub = /Closes #(\d+)/.exec(body)?.[1] ?? "";
  if (sub)
    console.error(`PR closes sub-issue #${sub}`);
  if (githubOutput) {
    appendFileSync(githubOutput, `parent_number=${parent}
sub_number=${sub}
`);
  }
}
if (import.meta.main)
  main();
export {
  ref
};

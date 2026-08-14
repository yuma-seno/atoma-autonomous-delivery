#!/usr/bin/env bun
// @bun

// src/scripts/check_sub_issue_closure.ts
import { readFileSync, appendFileSync } from "fs";

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
function ghGraphql(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push("-F", `${key}=${value}`);
  }
  const { code, stdout, stderr } = gh(...args);
  if (code !== 0) {
    throw new Error(`GraphQL query failed: ${stderr || stdout.slice(0, 200)}`);
  }
  const result = JSON.parse(stdout);
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
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

// src/scripts/check_sub_issue_closure.ts
var ref = defineScript(import.meta.url);
function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const closedNum = process.env.CLOSED_NUM ?? "";
  const owner = process.env.OWNER ?? "";
  const repo = process.env.REPO ?? "";
  const githubOutput = process.env.GITHUB_OUTPUT;
  const event = eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : {};
  const body = event.issue?.body ?? "";
  const parent = PARENT_TAG.read(body);
  if (parent === undefined) {
    if (githubOutput)
      appendFileSync(githubOutput, `is_sub_issue=false
`);
    return;
  }
  console.error(`Sub-issue #${closedNum} closed \u2014 parent #${parent}`);
  let closedViaPr = false;
  try {
    const data = ghGraphql("query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){closedByPullRequestsReferences(first: 1) { nodes { number } }}}}", { owner, repo, num: Number(closedNum) });
    const mergedPr = data.repository.issue.closedByPullRequestsReferences.nodes[0]?.number;
    if (mergedPr) {
      console.error(`Closed via merged PR #${mergedPr} \u2014 already handled by atoma-pr-merged.yml. Skipping.`);
      closedViaPr = true;
    }
  } catch {}
  if (githubOutput) {
    appendFileSync(githubOutput, ["is_sub_issue=true", `parent_number=${parent}`, `closed_via_pr=${closedViaPr}`].join(`
`) + `
`);
  }
}
if (import.meta.main)
  main();
export {
  ref
};

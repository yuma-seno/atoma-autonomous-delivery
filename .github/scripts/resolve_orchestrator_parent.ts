#!/usr/bin/env bun
// @bun

// src/scripts/resolve_orchestrator_parent.ts
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
var ORIGIN_AGENT_TAG = stringTag("origin-agent", "[a-z][a-z0-9-]*");
var DISPATCH_TAG = stringTag("dispatch", "[a-z][a-z0-9-]*");
var AGENT_TAG = stringTag("agent", "[a-z][a-z0-9-]*");
var LLM_CONTEXT_TAG = stringTag("llm-context", "include|exclude");
var AGGREGATED_TAG = numericTag("aggregated");
var SUB_RESULT_TAG = numericTag("sub-result");

// src/scripts/resolve_orchestrator_parent.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      sub: { type: "string" }
    }
  });
  if (!values.repo || !values.sub) {
    console.error("usage: resolve_orchestrator_parent.ts --repo OWNER/REPO --sub N");
    process.exit(2);
  }
  const [owner, repoName] = values.repo.split("/", 2);
  try {
    const data = ghGraphql("query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){parent{number}}}}", { owner, repo: repoName, num: Number(values.sub) });
    const parent2 = data.repository.issue.parent?.number;
    if (parent2) {
      console.error(`Resolved via GraphQL parent: sub-issue #${values.sub} \u2192 parent #${parent2}`);
      console.log(parent2);
      return;
    }
  } catch {}
  const { code, stdout } = gh("issue", "view", String(values.sub), "--repo", values.repo, "--json", "body", "--jq", ".body");
  const body = code === 0 ? stdout : "";
  const parent = PARENT_TAG.read(body);
  if (parent)
    console.error(`Resolved via fallback: sub-issue #${values.sub} \u2192 parent #${parent}`);
  console.log(parent ?? "");
}
if (import.meta.main)
  main();
export {
  ref
};

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

// src/lib/parent-issue.ts
function log(message) {
  console.error(`[atoma-parent] ${message}`);
}
function nativeParent(repo, issue) {
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name)
    return;
  try {
    const data = ghGraphql("query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){parent{number}}}}", { owner, repo: name, num: issue });
    return data.repository.issue.parent?.number;
  } catch {
    return;
  }
}
function parentIssueOf(repo, issue) {
  const native = nativeParent(repo, issue);
  if (native)
    return { known: true, parent: native };
  const { code, stderr, stdout } = gh("issue", "view", String(issue), "--repo", repo, "--json", "body", "--jq", ".body");
  if (code) {
    const why = `could not read issue #${issue}: ${stderr.trim() || `gh exited ${code}`}`;
    log(`WARN ${why}`);
    return { known: false, why };
  }
  return { known: true, parent: PARENT_TAG.read(stdout) ?? 0 };
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

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
  const found = parentIssueOf(values.repo, Number(values.sub));
  if (!found.known) {
    console.error(`::error::${found.why}`);
    process.exit(1);
  }
  if (found.parent)
    console.error(`sub-issue #${values.sub} -> parent #${found.parent}`);
  console.log(found.parent || "");
}
if (import.meta.main)
  main();
export {
  ref
};

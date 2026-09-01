#!/usr/bin/env bun
// @bun

// src/scripts/restore_workspace.ts
import { appendFileSync, mkdirSync as mkdirSync2 } from "fs";
import { parseArgs } from "util";

// src/scripts/lib/atoma-data.ts
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";

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
function gitRun(...args) {
  return run(["git", ...args]);
}

// src/scripts/lib/atoma-data.ts
function workspaceTargetPrefix(rootIssue) {
  return `workspace/issue-${rootIssue}`;
}
function restoreWorkspace(prefix, destDir) {
  if (gitRun("fetch", "origin", "atoma-data", "--depth=1").code !== 0)
    return false;
  if (gitRun("cat-file", "-e", `origin/atoma-data:${prefix}`).code !== 0)
    return false;
  mkdirSync(destDir, { recursive: true });
  const archive = Bun.spawnSync({
    cmd: ["git", "archive", "--format=tar", `origin/atoma-data:${prefix}`],
    stdout: "pipe",
    stderr: "pipe"
  });
  if (archive.exitCode !== 0) {
    console.error(`[atoma-data] git archive failed: ${archive.stderr.toString().trim()}`);
    return false;
  }
  const extract = Bun.spawnSync({
    cmd: ["tar", "-x", "-C", destDir],
    stdin: archive.stdout,
    stdout: "pipe",
    stderr: "pipe"
  });
  if (extract.exitCode !== 0) {
    console.error(`[atoma-data] tar failed: ${extract.stderr.toString().trim()}`);
    return false;
  }
  return true;
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
var CHANGED_TAG = stringTag("changed", "yes|no");
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

// src/domain/workspace.ts
var WORKSPACE_PATH = "/tmp/atoma-workspace";
var WORKSPACE_SENTENCE = `Anything under ${WORKSPACE_PATH} survives into the next run on this issue and is shared with the other ` + `agents working on it. Nothing else outside the repository survives. Put notes, scratch scripts and ` + `intermediate output there rather than in the repository, where they would be committed as part of the work.`;
function workspaceScope(target, parents, why = "") {
  const root = parents.length > 0 ? parents[parents.length - 1] : undefined;
  if (root === undefined) {
    return { rootIssue: String(target), resolved: why === "", why };
  }
  return { rootIssue: String(root), resolved: true, why: "" };
}

// src/lib/workspace-scope.ts
var MAX_HOPS = 6;
function log2(message) {
  console.error(`[atoma-workspace] ${message}`);
}
function issueOfPullRequest(repo, number) {
  const { code, stdout } = gh("pr", "view", String(number), "--repo", repo, "--json", "body", "--jq", ".body");
  if (code) {
    log2(`WARN could not read pull request #${number}`);
    return;
  }
  return PARENT_ISSUE_TAG.read(stdout);
}
function resolveWorkspaceScope(repo, type, number) {
  const target = Number(number);
  if (!Number.isFinite(target) || target <= 0) {
    return workspaceScope(number, [], `"${number}" is not an issue or pull request number`);
  }
  const chain = [];
  let current = target;
  if (type === "pr") {
    const issue = issueOfPullRequest(repo, target);
    if (issue === undefined) {
      log2(`#${target} names no parent issue; its workspace is its own`);
      return workspaceScope(number, []);
    }
    chain.push(issue);
    current = issue;
  }
  const visited = new Set([target]);
  for (let hop = 0;hop < MAX_HOPS; hop++) {
    if (visited.has(current) && hop > 0) {
      log2(`WARN parent chain revisits #${current}; stopping the walk here`);
      break;
    }
    visited.add(current);
    const parentage = parentIssueOf(repo, current);
    if (!parentage.known) {
      return workspaceScope(number, chain, chain.length > 0 ? "" : parentage.why);
    }
    if (parentage.parent === 0)
      break;
    chain.push(parentage.parent);
    current = parentage.parent;
  }
  const scope = workspaceScope(number, chain);
  if (!scope.resolved)
    log2(`WARN ${scope.why}; using this target's own workspace`);
  else if (scope.rootIssue !== String(number))
    log2(`sharing issue #${scope.rootIssue}'s workspace`);
  return scope;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/restore_workspace.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: "string" },
      number: { type: "string" },
      dest: { type: "string" },
      repo: { type: "string" }
    }
  });
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!values.type || !values.number || !values.dest || !repo) {
    console.error("usage: restore_workspace.ts --type issue|pr --number N --dest PATH [--repo owner/name]");
    process.exit(2);
  }
  const scope = resolveWorkspaceScope(repo, values.type, values.number);
  const prefix = workspaceTargetPrefix(scope.rootIssue);
  mkdirSync2(values.dest, { recursive: true });
  const restored = restoreWorkspace(prefix, values.dest);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `root_issue=${scope.rootIssue}
restored=${restored}
`);
  }
  console.error(restored ? `[atoma-workspace] restored ${prefix} into ${values.dest}` : `[atoma-workspace] nothing stored at ${prefix} yet; ${values.dest} starts empty`);
}
if (import.meta.main)
  main();
export {
  ref
};

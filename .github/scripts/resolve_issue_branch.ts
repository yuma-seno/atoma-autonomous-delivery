#!/usr/bin/env bun
// @bun

// src/scripts/resolve_issue_branch.ts
import { appendFileSync } from "fs";
import { parseArgs } from "util";

// src/domain/issue-branch.ts
var SUFFIX = /-(\d+)$/;
function ordinalOf(name, prefix) {
  const rest = name.slice(prefix.length);
  if (rest === "")
    return 1;
  const match = SUFFIX.exec(rest);
  return match ? Number(match[1]) : 0;
}
function ownedBranches(branches, issueNumber) {
  const prefix = `atoma/issue-${issueNumber}`;
  return branches.filter((branch) => branch.name === prefix || SUFFIX.test(branch.name.slice(prefix.length))).map((branch) => ({ branch, ordinal: ordinalOf(branch.name, prefix) })).filter((entry) => entry.ordinal > 0).sort((a, b) => b.ordinal - a.ordinal);
}
function branchToResume(branches, issueNumber) {
  const unmerged = ownedBranches(branches, issueNumber).find((entry) => !entry.branch.merged);
  return unmerged?.branch.name ?? "";
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

// src/lib/issue-branches.ts
function log(message) {
  console.error(`[atoma-issue-branch] ${message}`);
}
function collectIssueBranches(repo, issueNumber) {
  const refs = gh("api", `repos/${repo}/git/matching-refs/heads/atoma/issue-${issueNumber}`);
  if (refs.code) {
    log(`WARN could not list branches: ${refs.stderr || refs.stdout}`);
    return [];
  }
  let names;
  try {
    const parsed = JSON.parse(refs.stdout || "[]");
    names = parsed.map((entry) => entry.ref.replace(/^refs\/heads\//, ""));
  } catch {
    log("WARN branch list was not valid JSON");
    return [];
  }
  const owner = repo.split("/", 1)[0] ?? "";
  return names.map((name) => ({ name, merged: headBranchMerged(repo, owner, name) }));
}
function headBranchMerged(repo, owner, branch) {
  const prs = gh("api", `repos/${repo}/pulls?state=all&per_page=100&head=${owner}:${branch}`);
  if (prs.code) {
    log(`WARN could not read pull requests for ${branch}; treating it as unmerged`);
    return false;
  }
  try {
    const parsed = JSON.parse(prs.stdout || "[]");
    return parsed.some((pr) => Boolean(pr.merged_at));
  } catch {
    log(`WARN pull request list for ${branch} was not valid JSON`);
    return false;
  }
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/resolve_issue_branch.ts
var ref = defineScript(import.meta.url);
function log2(message) {
  console.error(`[atoma-issue-branch] ${message}`);
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { repo: { type: "string" }, issue: { type: "string" } }
  });
  const repo = (values.repo ?? "").trim();
  const issue = Number(values.issue);
  const githubOutput = process.env.GITHUB_OUTPUT;
  let branch = "";
  if (repo && Number.isInteger(issue) && issue > 0) {
    branch = branchToResume(collectIssueBranches(repo, issue), issue);
  } else {
    log2("missing --repo or --issue; staying on the base branch");
  }
  log2(branch ? `resuming ${branch}` : "no branch to resume; starting from the base branch");
  if (githubOutput)
    appendFileSync(githubOutput, `branch=${branch}
`);
}
if (import.meta.main)
  main();
export {
  ref
};

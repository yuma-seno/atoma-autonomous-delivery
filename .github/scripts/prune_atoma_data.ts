#!/usr/bin/env bun
// @bun

// src/scripts/prune_atoma_data.ts
import { parseArgs } from "util";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
function gitRun(...args) {
  return run(["git", ...args]);
}
function splitConcatenatedJson(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0;i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped)
        escaped = false;
      else if (c === "\\")
        escaped = true;
      else if (c === '"')
        inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") {
      if (depth === 0)
        start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return results;
}
function ghPaginated(...args) {
  const { code, stdout, stderr } = gh(...args, "--paginate");
  if (code !== 0) {
    throw new Error(`gh ${args.join(" ")} --paginate: ${stderr || stdout}`);
  }
  if (!stdout.trim())
    return [];
  const flat = [];
  for (const page of splitConcatenatedJson(stdout)) {
    if (Array.isArray(page))
      flat.push(...page);
  }
  return flat;
}

// src/lib/config.ts
import { readFileSync } from "fs";

// src/domain/merge-readiness.ts
var CI_WOULD_BE_WASTED = new Set([
  "not-open",
  "draft",
  "conflicting",
  "behind",
  "mergeability-unknown",
  "checks-pending",
  "checks-failing"
]);
var PASSING = new Set(["success", "neutral", "skipped"]);

// src/lib/config.ts
function configPath() {
  const root = process.env.ATOMA_MACHINERY_ROOT?.trim();
  return root ? `${root}/.github/atoma/config.json` : ".github/atoma/config.json";
}
var cached;
function loadConfig() {
  if (!cached) {
    cached = JSON.parse(readFileSync(configPath(), "utf8"));
  }
  return cached;
}
var DEFAULT_LABELS = {
  sub_issue: "atoma/sub-issue",
  launched: "atoma/launched",
  in_progress: "atoma/in-progress"
};
function getLabel(key) {
  return loadConfig().labels?.[key] ?? DEFAULT_LABELS[key];
}

// src/domain/atoma-data-pruning.ts
var OWNED_TREES = ["workspace/"];
function issueNumberOf(path) {
  const tree = OWNED_TREES.find((prefix) => path.startsWith(prefix));
  if (tree === undefined)
    return;
  const rest = path.slice(tree.length);
  const match = /^issue-(\d+)(?:[-/.]|$)/.exec(rest);
  if (match === undefined || match === null)
    return;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
function prunablePaths(paths, isOver) {
  const verdicts = new Map;
  const out = [];
  const issues = new Set;
  for (const path of paths) {
    const issue = issueNumberOf(path);
    if (issue === undefined)
      continue;
    if (!verdicts.has(issue))
      verdicts.set(issue, isOver(issue));
    if (!verdicts.get(issue))
      continue;
    out.push(path);
    issues.add(issue);
  }
  return { paths: out, issues: [...issues].sort((a, b) => a - b) };
}
function pruneCommitMessage(decision) {
  const files = `${decision.paths.length} file${decision.paths.length === 1 ? "" : "s"}`;
  const listed = decision.issues.map((n) => `#${n}`).join(", ");
  return `atoma: prune ${files} from closed issues (${listed})`;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/prune_atoma_data.ts
var ref = defineScript(import.meta.url);
var BRANCH = "atoma-data";
function log(message) {
  console.error(`[prune-atoma-data] ${message}`);
}
function issueStates(repo) {
  const byNumber = new Map;
  for (const state of ["open", "closed"]) {
    const page = ghPaginated("api", `repos/${repo}/issues?state=${state}&per_page=100`);
    for (const issue of page) {
      if (issue.pull_request !== undefined)
        continue;
      byNumber.set(issue.number, issue);
    }
  }
  return byNumber;
}
function isOver(states, inProgressLabel, issue) {
  const found = states.get(issue);
  if (found === undefined) {
    log(`#${issue} could not be read; leaving its files alone`);
    return false;
  }
  if (found.state !== "closed")
    return false;
  if ((found.labels ?? []).some((label) => label.name === inProgressLabel)) {
    log(`#${issue} is closed but still carries ${inProgressLabel}; leaving its files alone`);
    return false;
  }
  return true;
}
function storedPaths() {
  const listed = gitRun("ls-tree", "-r", "--name-only", `origin/${BRANCH}`);
  if (listed.code !== 0) {
    log(`could not list ${BRANCH}: ${listed.stderr || listed.stdout}`);
    return [];
  }
  return listed.stdout.split(`
`).map((line) => line.trim()).filter(Boolean);
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { repo: { type: "string" }, "dry-run": { type: "boolean" } }
  });
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!repo) {
    console.error("usage: prune_atoma_data.ts [--repo OWNER/REPO] [--dry-run]");
    process.exit(2);
  }
  if (gitRun("fetch", "origin", BRANCH).code !== 0) {
    log(`${BRANCH} does not exist; nothing to prune`);
    return;
  }
  const paths = storedPaths();
  const states = issueStates(repo);
  const inProgress = getLabel("in_progress");
  const decision = prunablePaths(paths, (issue) => isOver(states, inProgress, issue));
  log(`${paths.length} stored files, ${decision.paths.length} belong to closed issues`);
  if (decision.paths.length === 0)
    return;
  log(`issues: ${decision.issues.map((n) => `#${n}`).join(", ")}`);
  if (values["dry-run"]) {
    for (const path of decision.paths)
      console.error(`  would delete ${path}`);
    return;
  }
  const worktree = mkdtempSync(join(tmpdir(), "atoma-data-prune-"));
  try {
    gitRun("worktree", "add", worktree, `origin/${BRANCH}`);
    const git = (...args) => Bun.spawnSync({ cmd: ["git", ...args], cwd: worktree, stdout: "pipe", stderr: "pipe" });
    git("config", "user.email", "action@github.com");
    git("config", "user.name", "GitHub Actions");
    for (let attempt = 1;attempt <= 3; attempt++) {
      git("fetch", "origin", BRANCH);
      git("reset", "--hard", `origin/${BRANCH}`);
      const present = decision.paths.filter((path) => existsSync(join(worktree, path)));
      if (present.length === 0) {
        log("nothing left to delete after the refetch");
        return;
      }
      git("rm", "-q", "--", ...present);
      git("commit", "-m", pruneCommitMessage({ ...decision, paths: present }));
      if ((git("push", "origin", `HEAD:${BRANCH}`).exitCode ?? 1) === 0) {
        log(`deleted ${present.length} files`);
        return;
      }
      log(`push attempt ${attempt} lost a race; refetching`);
      Bun.sleepSync(attempt * 2000);
    }
    log("gave up after three attempts; the next issue to close will try again");
  } finally {
    gitRun("worktree", "remove", "--force", worktree);
    rmSync(worktree, { recursive: true, force: true });
  }
}
if (import.meta.main)
  main();
export {
  ref
};

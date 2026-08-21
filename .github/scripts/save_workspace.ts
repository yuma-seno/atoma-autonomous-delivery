#!/usr/bin/env bun
// @bun

// src/scripts/save_workspace.ts
import { existsSync as existsSync2, readdirSync as readdirSync2 } from "fs";
import { parseArgs } from "util";

// src/scripts/lib/atoma-data.ts
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

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
function gitRun(...args) {
  return run(["git", ...args]);
}

// src/scripts/lib/atoma-data.ts
function gitIn(cwd, ...args) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "" };
}
function workspaceTargetPrefix(rootIssue) {
  return `workspace/issue-${rootIssue}`;
}
function saveWorkspace(prefix, sourceDir, commitMessage) {
  if (!existsSync(sourceDir))
    return true;
  if (gitRun("ls-remote", "--exit-code", "origin", "atoma-data").code !== 0) {
    console.error("[atoma-data] atoma-data does not exist yet; skipping workspace save");
    return false;
  }
  gitRun("fetch", "origin", "atoma-data");
  const worktreeDir = mkdtempSync(join(tmpdir(), "atoma-data-ws-"));
  gitRun("worktree", "add", worktreeDir, "origin/atoma-data");
  let saved = false;
  try {
    gitIn(worktreeDir, "config", "user.email", "action@github.com");
    gitIn(worktreeDir, "config", "user.name", "GitHub Actions");
    for (let attempt = 1;attempt <= 5; attempt++) {
      gitIn(worktreeDir, "fetch", "origin", "atoma-data");
      gitIn(worktreeDir, "reset", "--hard", "origin/atoma-data");
      const target = join(worktreeDir, prefix);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      cpSync(sourceDir, target, { recursive: true });
      gitIn(worktreeDir, "add", "--all", prefix);
      if (gitIn(worktreeDir, "diff", "--cached", "--quiet").code === 0) {
        saved = true;
        break;
      }
      gitIn(worktreeDir, "commit", "-m", commitMessage);
      if (gitIn(worktreeDir, "push", "origin", "HEAD:atoma-data").code === 0) {
        saved = true;
        break;
      }
      console.error(`[atoma-data] workspace push attempt ${attempt} failed (concurrent push) -- retrying`);
      Bun.sleepSync(attempt * 2000);
    }
  } finally {
    gitRun("worktree", "remove", "--force", worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  }
  return saved;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/save_workspace.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "root-issue": { type: "string" },
      source: { type: "string" },
      agent: { type: "string" }
    }
  });
  const root = values["root-issue"];
  const source = values.source;
  if (!root || !source) {
    console.error("usage: save_workspace.ts --root-issue N --source PATH [--agent NAME]");
    process.exit(2);
  }
  if (!existsSync2(source)) {
    console.error(`[atoma-workspace] ${source} does not exist; nothing to save`);
    return;
  }
  const count = readdirSync2(source).length;
  const prefix = workspaceTargetPrefix(root);
  const saved = saveWorkspace(prefix, source, `atoma: workspace for issue #${root}${values.agent ? ` (${values.agent})` : ""} \u2014 ${count} entries`);
  console.error(saved ? `[atoma-workspace] saved ${count} entries to ${prefix}` : `[atoma-workspace] WARN could not save ${prefix}; the next run on this issue starts without these files`);
}
if (import.meta.main)
  main();
export {
  ref
};

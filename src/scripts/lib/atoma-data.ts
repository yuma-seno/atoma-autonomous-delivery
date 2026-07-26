/**
 * atoma-data.ts — helpers for reading/writing per-agent session.json files
 * on the orphan `atoma-data` git branch, this repo's persistent session
 * store (GitHub Actions runners have no other durable storage between runs).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitRun } from "../../lib/gh.ts";

/** Path of a given agent's session file on the atoma-data branch. */
export function sessionTargetPath(type: string, number: string | number, agent: string): string {
  return `sessions/${type}-${number}/${agent}.json`;
}

export function nextArchiveSessionPath(
  type: string,
  number: string | number,
  agent: string,
  existingNames: readonly string[],
): string {
  const escapedAgent = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const archivePattern = new RegExp(`^${escapedAgent}-(\\d+)\\.json$`);
  const nextNumber = existingNames
    .map((name) => archivePattern.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .reduce((max, match) => Math.max(max, Number(match[1])), 0) + 1;
  return `sessions/${type}-${number}/archive/${agent}-${nextNumber}.json`;
}

/**
 * Reads `targetPath`'s content from the `atoma-data` branch's tip on
 * `origin`, WITHOUT checking out or otherwise disturbing the current
 * working tree/branch (just `git fetch` + `git show <ref>:<path>`).
 * Returns undefined if the branch, or the file within it, doesn't exist yet.
 */
export function restoreSession(targetPath: string): string | undefined {
  if (gitRun("fetch", "origin", "atoma-data", "--depth=1").code !== 0) {
    return undefined;
  }
  if (gitRun("cat-file", "-e", `origin/atoma-data:${targetPath}`).code !== 0) {
    return undefined;
  }
  const shown = gitRun("show", `origin/atoma-data:${targetPath}`);
  return shown.code === 0 ? shown.stdout : undefined;
}

function gitIn(cwd: string, ...args: string[]): { code: number; stdout: string } {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "" };
}

/**
 * Writes `content` to `targetPath` on the `atoma-data` branch and pushes it,
 * retrying on push races (parallel agents -- e.g. sibling sub-issue
 * engineers running at the same time -- each write to their own uniquely
 * named target path, but all push to the SAME atoma-data branch, so a race
 * is expected, not exceptional).
 *
 * Uses a separate git worktree (unlike `restoreSession`, which is a safe
 * read-only `git show`) so the CURRENT checkout/branch -- which may hold the
 * agent's own real, possibly-uncommitted code changes at this point in the
 * job -- is never disturbed. Returns true if the save succeeded (or the
 * content was already identical -- a no-op "save").
 */
export function saveSession(targetPath: string, content: string, commitMessage: string): boolean {
  if (gitRun("ls-remote", "--exit-code", "origin", "atoma-data").code !== 0) {
    gitRun("config", "user.email", "action@github.com");
    gitRun("config", "user.name", "GitHub Actions");
    // 4b825dc6... is Git's canonical empty-tree SHA (never changes).
    const commit = gitRun("commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "init: atoma-data session store").stdout;
    gitRun("push", "origin", `${commit}:refs/heads/atoma-data`);
  }

  gitRun("fetch", "origin", "atoma-data");
  const worktreeDir = mkdtempSync(join(tmpdir(), "atoma-data-wt-"));
  gitRun("worktree", "add", worktreeDir, "origin/atoma-data");

  let saved = false;
  try {
    gitIn(worktreeDir, "config", "user.email", "action@github.com");
    gitIn(worktreeDir, "config", "user.name", "GitHub Actions");

    for (let attempt = 1; attempt <= 5; attempt++) {
      gitIn(worktreeDir, "fetch", "origin", "atoma-data");
      gitIn(worktreeDir, "reset", "--hard", "origin/atoma-data");

      const fullTarget = join(worktreeDir, targetPath);
      mkdirSync(dirname(fullTarget), { recursive: true });
      writeFileSync(fullTarget, content);
      gitIn(worktreeDir, "add", targetPath);

      if (gitIn(worktreeDir, "diff", "--cached", "--quiet").code === 0) {
        saved = true;
        break;
      }

      gitIn(worktreeDir, "commit", "-m", commitMessage);

      if (gitIn(worktreeDir, "push", "origin", "HEAD:atoma-data").code === 0) {
        saved = true;
        break;
      }

      console.error(`Push attempt ${attempt} failed (concurrent push) -- resetting and retrying with a fresh pull...`);
      Bun.sleepSync(attempt * 2000);
    }
  } finally {
    gitRun("worktree", "remove", "--force", worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  return saved;
}

/**
 * Preserve a session before recovery as the next numbered archive entry.
 * Number allocation happens inside the retrying atoma-data worktree so two
 * recoveries racing on the same context cannot select the same archive path.
 */
export function archiveSession(
  type: string,
  number: string | number,
  agent: string,
  content: string,
): string | undefined {
  if (gitRun("ls-remote", "--exit-code", "origin", "atoma-data").code !== 0) return undefined;

  gitRun("fetch", "origin", "atoma-data");
  const worktreeDir = mkdtempSync(join(tmpdir(), "atoma-data-archive-wt-"));
  gitRun("worktree", "add", worktreeDir, "origin/atoma-data");

  let archivedPath: string | undefined;
  try {
    gitIn(worktreeDir, "config", "user.email", "action@github.com");
    gitIn(worktreeDir, "config", "user.name", "GitHub Actions");

    for (let attempt = 1; attempt <= 5; attempt++) {
      gitIn(worktreeDir, "fetch", "origin", "atoma-data");
      gitIn(worktreeDir, "reset", "--hard", "origin/atoma-data");

      const archiveDir = join(worktreeDir, `sessions/${type}-${number}/archive`);
      mkdirSync(archiveDir, { recursive: true });
      const relativePath = nextArchiveSessionPath(type, number, agent, readdirSync(archiveDir));
      const fullPath = join(worktreeDir, relativePath);
      if (existsSync(fullPath)) continue;

      writeFileSync(fullPath, content);
      gitIn(worktreeDir, "add", relativePath);
      gitIn(worktreeDir, "commit", "-m", `session: archive ${agent} on ${type} ${number}`);

      if (gitIn(worktreeDir, "push", "origin", "HEAD:atoma-data").code === 0) {
        archivedPath = relativePath;
        break;
      }

      console.error(`Archive push attempt ${attempt} failed -- retrying with the latest atoma-data branch.`);
      Bun.sleepSync(attempt * 2000);
    }
  } finally {
    gitRun("worktree", "remove", "--force", worktreeDir);
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  return archivedPath;
}


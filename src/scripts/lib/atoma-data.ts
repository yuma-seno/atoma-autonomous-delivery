/**
 * atoma-data.ts — helpers for reading/writing per-agent session.json files
 * on the orphan `atoma-data` git branch, this repo's persistent session
 * store (GitHub Actions runners have no other durable storage between runs).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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


// ── The agent's scratch workspace ─────────────────────────────────────────────
//
// A directory rather than a file, and the difference is why these two functions
// exist alongside the session pair above.
//
// `restoreSession` reads with `git show <ref>:<path>`, which only works on a blob.
// `saveSession` writes one file into a real worktree. A workspace is a tree of
// whatever the agent chose to leave there, so both halves need the tree form.
//
// See `domain/workspace.ts` for what the directory is FOR and why it is a
// directory instead of a pair of evacuate/retrieve tools.

/** Where a root issue's workspace lives on the atoma-data branch. */
export function workspaceTargetPrefix(rootIssue: string | number): string {
  return `workspace/issue-${rootIssue}`;
}

/**
 * Unpack `prefix` from the atoma-data branch into `destDir`.
 *
 * `git archive | tar -x` rather than a sparse checkout: it needs no worktree, no
 * index and no branch switch, which is the same property that makes
 * `restoreSession` safe to call in the middle of a run.
 *
 * Returns false when there is nothing stored yet -- the ordinary case on the first
 * run for an issue, not a failure.
 */
export function restoreWorkspace(prefix: string, destDir: string): boolean {
  if (gitRun("fetch", "origin", "atoma-data", "--depth=1").code !== 0) return false;
  // `cat-file -e` on a tree tells us whether anything was ever saved, and keeps a
  // missing workspace from looking like a failed extraction.
  if (gitRun("cat-file", "-e", `origin/atoma-data:${prefix}`).code !== 0) return false;

  mkdirSync(destDir, { recursive: true });
  const archive = Bun.spawnSync({
    cmd: ["git", "archive", "--format=tar", `origin/atoma-data:${prefix}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (archive.exitCode !== 0) {
    console.error(`[atoma-data] git archive failed: ${archive.stderr.toString().trim()}`);
    return false;
  }
  const extract = Bun.spawnSync({
    cmd: ["tar", "-x", "-C", destDir],
    stdin: archive.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (extract.exitCode !== 0) {
    console.error(`[atoma-data] tar failed: ${extract.stderr.toString().trim()}`);
    return false;
  }
  return true;
}

/**
 * Replace `prefix` on the atoma-data branch with the contents of `sourceDir`.
 *
 * Replace, not merge. A file the agent deleted has to be gone next run, or the
 * workspace becomes a place where deletions do not take -- the same silent shape
 * `unzip -o` produced for `.github/` before `self/` (see
 * `tests/contract/self-overlay.test.ts`). `git add --all <prefix>` after removing
 * the old tree stages the deletions along with the additions.
 *
 * The retry loop is `saveSession`'s, for the same reason: sibling agents on
 * decomposed issues push to this branch concurrently, and a rejected push means
 * someone else got there first rather than that anything is wrong.
 */
export function saveWorkspace(prefix: string, sourceDir: string, commitMessage: string): boolean {
  if (!existsSync(sourceDir)) return true;
  if (gitRun("ls-remote", "--exit-code", "origin", "atoma-data").code !== 0) {
    // No branch yet means no session has ever been saved either. Leave creating it
    // to `saveSession`, which runs in the same job: a workspace with no session is
    // not a state worth bringing into existence.
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

    for (let attempt = 1; attempt <= 5; attempt++) {
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

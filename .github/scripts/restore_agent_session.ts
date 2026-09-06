#!/usr/bin/env bun
// @bun

// src/scripts/restore_agent_session.ts
import { writeFileSync as writeFileSync2 } from "fs";
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
function sessionTargetPath(type, number, agent) {
  return `sessions/${type}-${number}/${agent}.json`;
}
function nextArchiveSessionPath(type, number, agent, existingNames) {
  const escapedAgent = agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const archivePattern = new RegExp(`^${escapedAgent}-(\\d+)\\.json$`);
  const nextNumber = existingNames.map((name) => archivePattern.exec(name)).filter((match) => match !== null).reduce((max, match) => Math.max(max, Number(match[1])), 0) + 1;
  return `sessions/${type}-${number}/archive/${agent}-${nextNumber}.json`;
}
function restoreSession(targetPath) {
  if (gitRun("fetch", "origin", "atoma-data", "--depth=1").code !== 0) {
    return;
  }
  if (gitRun("cat-file", "-e", `origin/atoma-data:${targetPath}`).code !== 0) {
    return;
  }
  const shown = gitRun("show", `origin/atoma-data:${targetPath}`);
  return shown.code === 0 ? shown.stdout : undefined;
}
function gitIn(cwd, ...args) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "" };
}
function archiveSession(type, number, agent, content) {
  if (gitRun("ls-remote", "--exit-code", "origin", "atoma-data").code !== 0)
    return;
  gitRun("fetch", "origin", "atoma-data");
  const worktreeDir = mkdtempSync(join(tmpdir(), "atoma-data-archive-wt-"));
  gitRun("worktree", "add", worktreeDir, "origin/atoma-data");
  let archivedPath;
  try {
    gitIn(worktreeDir, "config", "user.email", "action@github.com");
    gitIn(worktreeDir, "config", "user.name", "GitHub Actions");
    for (let attempt = 1;attempt <= 5; attempt++) {
      gitIn(worktreeDir, "fetch", "origin", "atoma-data");
      gitIn(worktreeDir, "reset", "--hard", "origin/atoma-data");
      const archiveDir = join(worktreeDir, `sessions/${type}-${number}/archive`);
      mkdirSync(archiveDir, { recursive: true });
      const relativePath = nextArchiveSessionPath(type, number, agent, readdirSync(archiveDir));
      const fullPath = join(worktreeDir, relativePath);
      if (existsSync(fullPath))
        continue;
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

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/domain/session-size.ts
var KEEP_RECENT_RESULTS = 10;
var SESSION_TOKEN_LIMIT = 1e5;
var CHARS_PER_TOKEN = 4;
function estimateTokens(session) {
  const messages = session.messages ?? [];
  if (messages.length === 0)
    return 0;
  return Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN);
}
function contentText(content) {
  if (typeof content === "string")
    return content;
  return;
}
function removedResultNotice(originalLength) {
  return `[atoma] This result (${originalLength} characters) was removed so the session fits in the ` + "model's context window. The call that produced it is still above \u2014 call it again if you need it.";
}
function replaceOldToolResults(session, keepRecent = KEEP_RECENT_RESULTS) {
  const messages = session.messages ?? [];
  const tokensBefore = estimateTokens(session);
  const resultIndexes = messages.map((m, i) => m.role === "tool" ? i : -1).filter((i) => i >= 0);
  const replaceBefore = resultIndexes[resultIndexes.length - keepRecent] ?? Infinity;
  let changed = 0;
  const kept = messages.map((message, i) => {
    if (message.role !== "tool" || i >= replaceBefore)
      return message;
    const text = contentText(message.content);
    if (text === undefined || text.length <= 200)
      return message;
    changed += 1;
    return { ...message, content: removedResultNotice(text.length) };
  });
  if (changed === 0) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, changed: 0 };
  }
  const out = { ...session, messages: [...kept, shrinkNotice(changed)] };
  return { session: out, shrunk: true, tokensBefore, tokensAfter: estimateTokens(out), changed };
}
function shrinkNotice(changed) {
  return {
    role: "user",
    content: [
      `[atoma] The contents of ${changed} earlier tool results were removed from this session so it`,
      "fits in the model's context window.",
      "",
      "The calls themselves are still here, so you can see what you already looked at. What is gone is",
      "what came back: file contents, command output, search results. Call again for the ones you still",
      "need \u2014 do not answer from memory of something you can no longer see."
    ].join(`
`),
    atoma_metadata: { source: "atoma", layer: "session-shrink", changed }
  };
}
function shrinkIfNeeded(session, limit = SESSION_TOKEN_LIMIT) {
  const tokensBefore = estimateTokens(session);
  if (tokensBefore <= limit) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, changed: 0 };
  }
  return replaceOldToolResults(session);
}
function shrinkLogLine(outcome, what = "tool results replaced") {
  if (!outcome.shrunk)
    return;
  return `session shrunk: ${outcome.changed} ${what}, ` + `~${Math.round(outcome.tokensBefore / 1000)}k -> ~${Math.round(outcome.tokensAfter / 1000)}k estimated tokens`;
}
function stillTooBigLine(outcome, limit = SESSION_TOKEN_LIMIT) {
  if (outcome.tokensAfter <= limit)
    return;
  return `session is still ~${Math.round(outcome.tokensAfter / 1000)}k estimated tokens after shrinking, ` + `over the ~${Math.round(limit / 1000)}k this run allows. What is left is the conversation itself, ` + "which nothing here can shorten. This run will likely be refused by the provider; start the agent " + "again with a recover run (for example `/engineer recover`), which archives the session and begins fresh.";
}

// src/scripts/restore_agent_session.ts
var ref = defineScript(import.meta.url);
function findAgentSession(type, number, agent, load = restoreSession) {
  const target = sessionTargetPath(type, number, agent);
  return { target, content: load(target) };
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: "string" },
      number: { type: "string" },
      agent: { type: "string" },
      out: { type: "string" },
      "session-mode": { type: "string" }
    }
  });
  if (!values.type || !values.number || !values.agent || !values.out) {
    console.error("usage: restore_agent_session.ts --type issue|pr --number N --agent NAME --out session.json");
    process.exit(2);
  }
  const { target, content } = findAgentSession(values.type, values.number, values.agent);
  if (values["session-mode"] === "recover") {
    if (content === undefined) {
      console.error(`No existing session at ${target}; recovery will start fresh without an archive.`);
      return;
    }
    const archivedPath = archiveSession(values.type, values.number, values.agent, content);
    if (!archivedPath)
      throw new Error(`Failed to archive existing session before recovery: ${target}`);
    console.error(`Archived session to atoma-data:${archivedPath}; starting fresh.`);
    return;
  }
  if (content !== undefined) {
    writeFileSync2(values.out, sized(content, target));
    console.error(`Restored session: ${target}`);
  } else {
    console.error(`No existing session at ${target}, starting fresh.`);
  }
}
function sized(content, target) {
  let session;
  try {
    session = JSON.parse(content);
  } catch {
    console.error(`Could not read ${target} as JSON; restoring it unchanged.`);
    return content;
  }
  const result = shrinkIfNeeded(session);
  const shrank = shrinkLogLine(result, "tool results replaced with a note");
  if (shrank !== undefined)
    console.error(shrank);
  const stuck = stillTooBigLine(result);
  if (stuck !== undefined)
    console.error(stuck);
  if (shrank === undefined)
    return content;
  return JSON.stringify(result.session, null, 2);
}
if (import.meta.main)
  main();
export {
  findAgentSession,
  ref
};

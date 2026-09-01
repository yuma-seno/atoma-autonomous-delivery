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
var SESSION_TOKEN_LIMIT = 1e5;
var CHARS_PER_TOKEN = 4;
function estimateTokens(session) {
  const messages = session.messages ?? [];
  if (messages.length === 0)
    return 0;
  return Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN);
}
function hasText(content) {
  if (typeof content === "string")
    return content.trim() !== "";
  return Array.isArray(content) && content.length > 0;
}
function shrinkNotice(removed) {
  return {
    role: "user",
    content: [
      `[atoma] ${removed} earlier tool results were removed from this session so it fits in the model's context window.`,
      "",
      "Your own messages are unchanged, so what you concluded is still here. What is gone is what the tools returned:",
      "file contents, command output, search results. If you need any of it, call the tool again \u2014 do not answer from",
      "memory of something you can no longer see."
    ].join(`
`),
    atoma_metadata: { source: "atoma", layer: "session-shrink", removed }
  };
}
function dropToolTraffic(session) {
  const messages = session.messages ?? [];
  const tokensBefore = estimateTokens(session);
  const kept = [];
  let removed = 0;
  for (const message of messages) {
    if (message.role === "tool") {
      removed += 1;
      continue;
    }
    if (message.tool_calls === undefined) {
      kept.push(message);
      continue;
    }
    const { tool_calls: _dropped, ...rest } = message;
    if (hasText(rest.content)) {
      kept.push(rest);
    } else {
      removed += 1;
    }
  }
  if (removed === 0) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, removed: 0 };
  }
  kept.push(shrinkNotice(removed));
  const shrunkSession = { ...session, messages: kept };
  return {
    session: shrunkSession,
    shrunk: true,
    tokensBefore,
    tokensAfter: estimateTokens(shrunkSession),
    removed
  };
}
function shrinkIfNeeded(session, limit = SESSION_TOKEN_LIMIT) {
  const tokensBefore = estimateTokens(session);
  if (tokensBefore <= limit) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, removed: 0 };
  }
  return dropToolTraffic(session);
}
function shrinkLogLine(outcome) {
  if (!outcome.shrunk)
    return;
  return `session shrunk: ${outcome.removed} tool messages dropped, ` + `~${Math.round(outcome.tokensBefore / 1000)}k -> ~${Math.round(outcome.tokensAfter / 1000)}k estimated tokens`;
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
  const shrank = shrinkLogLine(result);
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

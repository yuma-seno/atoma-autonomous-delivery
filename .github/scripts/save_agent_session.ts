#!/usr/bin/env bun
// @bun

// src/scripts/save_agent_session.ts
import { existsSync as existsSync2, readFileSync } from "fs";
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
function gitIn(cwd, ...args) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "" };
}
function saveSession(targetPath, content, commitMessage) {
  if (gitRun("ls-remote", "--exit-code", "origin", "atoma-data").code !== 0) {
    gitRun("config", "user.email", "action@github.com");
    gitRun("config", "user.name", "GitHub Actions");
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
    for (let attempt = 1;attempt <= 5; attempt++) {
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

// src/domain/session-size.ts
var TOOL_RESULT_CAP = 4000;
var TOOL_CALL_ARGS_CAP = 20000;
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
function capText(text, limit) {
  if (text.length <= limit)
    return text;
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const dropped = text.length - limit;
  return text.slice(0, head) + `

[atoma] ${dropped} characters dropped from the middle; ${limit} shown

` + text.slice(text.length - tail);
}
function capToolResults(session, limit = TOOL_RESULT_CAP) {
  const messages = session.messages ?? [];
  const tokensBefore = estimateTokens(session);
  let changed = 0;
  const kept = messages.map((message) => {
    if (message.role === "tool") {
      const text = contentText(message.content);
      if (text === undefined || text.length <= limit)
        return message;
      changed += 1;
      return { ...message, content: capText(text, limit) };
    }
    const calls = message.tool_calls;
    if (!Array.isArray(calls))
      return message;
    let touched = false;
    const capped = calls.map((call) => {
      const fn = call.function;
      const args = fn?.arguments;
      if (typeof args !== "string" || args.length <= TOOL_CALL_ARGS_CAP)
        return call;
      touched = true;
      return { ...call, function: { ...fn, arguments: capText(args, TOOL_CALL_ARGS_CAP) } };
    });
    if (!touched)
      return message;
    changed += 1;
    return { ...message, tool_calls: capped };
  });
  if (changed === 0) {
    return { session, shrunk: false, tokensBefore, tokensAfter: tokensBefore, changed: 0 };
  }
  const out = { ...session, messages: kept };
  return { session: out, shrunk: true, tokensBefore, tokensAfter: estimateTokens(out), changed };
}
function shrinkLogLine(outcome, what = "tool results replaced") {
  if (!outcome.shrunk)
    return;
  return `session shrunk: ${outcome.changed} ${what}, ` + `~${Math.round(outcome.tokensBefore / 1000)}k -> ~${Math.round(outcome.tokensAfter / 1000)}k estimated tokens`;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/save_agent_session.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      session: { type: "string" },
      type: { type: "string" },
      number: { type: "string" },
      agent: { type: "string" }
    }
  });
  if (!values.session || !values.type || !values.number || !values.agent) {
    console.error("usage: save_agent_session.ts --session FILE --type issue|pr --number N --agent NAME");
    process.exit(2);
  }
  if (!existsSync2(values.session)) {
    console.error("No session.json found, skipping save.");
    return;
  }
  const target = sessionTargetPath(values.type, values.number, values.agent);
  const content = capped(readFileSync(values.session, "utf8"));
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const saved = saveSession(target, content, `session: ${values.agent} on ${values.type} ${values.number} (run ${runId})`);
  if (!saved) {
    console.log(`::warning::Failed to save session to atoma-data:${target} after all retries.`);
  } else {
    console.error(`Session saved to atoma-data:${target}`);
  }
}
function capped(content) {
  let session;
  try {
    session = JSON.parse(content);
  } catch {
    console.error("Could not read the session as JSON; saving it unchanged.");
    return content;
  }
  const result = capToolResults(session);
  const line = shrinkLogLine(result, "oversized tool results shortened");
  if (line !== undefined)
    console.error(line);
  return result.shrunk ? JSON.stringify(result.session, null, 2) : content;
}
if (import.meta.main)
  main();
export {
  ref
};

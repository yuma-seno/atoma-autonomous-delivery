#!/usr/bin/env bun
// @bun

// src/atoma/tools/scripts/hooks/shell_guard.ts
import { readFileSync, writeFileSync } from "fs";
import { resolve, sep } from "path";

// src/domain/search-streak.ts
var MAX_SEARCHES_WITHOUT_OPENING = 15;
var SEARCHES = /^(grep|egrep|fgrep|rg|ag|ack|ugrep|find)$/;
var OPENS = /^(cat|bat|head|tail|sed|less|more|nl|od|xxd)$/;
function classifyShellAct(command) {
  const first = command.trim().split(/\s*(?:\|\||&&|[;|])\s*/)[0]?.trim().split(/\s+/).find((token) => token.length > 0 && !token.includes("=") && token !== "sudo" && token !== "time");
  if (first === undefined)
    return "other";
  const name = first.split("/").pop() ?? first;
  if (SEARCHES.test(name))
    return "search";
  if (OPENS.test(name))
    return "open";
  return "other";
}
function nextStreak(streak, act) {
  if (act === "search")
    return streak + 1;
  if (act === "open")
    return 0;
  return streak;
}
function refusalReason(streak, limit = MAX_SEARCHES_WITHOUT_OPENING) {
  if (streak < limit)
    return;
  return `${streak} searches in a row without opening any of the files they found. A search returns ` + "where something is, not what it is, so nothing found so far has been read. Open the most " + "promising result \u2014 with filesystem__read_text_file, or `sed -n` for a range \u2014 before searching again. " + "If the answer needs understanding rather than locating, say what tool you are missing and end.";
}

// src/atoma/tools/scripts/hooks/shell_guard.ts
var ROUTING_RULES = [
  [
    /\bgh\b/,
    "gh CLI is disabled. Use the atoma_github MCP tools (github__create_pr, github__create_issue, etc.) for GitHub operations."
  ],
  [/\bcurl\b/, "curl is disabled. Use web__fetch, which returns the page as text."],
  [/\bwget\b/, "wget is disabled. Use web__fetch."],
  [/\bssh\b/, "ssh is disabled: this run works on the checked-out repository, not on other hosts."],
  [/\bscp\b/, "scp is disabled: this run works on the checked-out repository, not on other hosts."],
  [/\brsync\b/, "rsync is disabled: this run works on the checked-out repository, not on other hosts."]
];
var PROCESS_ENVIRONMENT_READ = [
  /^(?=[\s\S]*\/proc)(?=[\s\S]*\benviron\b)/,
  "Reading a process's environment through /proc is disabled: tool servers run as the same user and each holds only the credentials it declares."
];
var ROUTED_GIT_COMMANDS = new Set([
  "add",
  "am",
  "apply",
  "cherry-pick",
  "commit",
  "fetch",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "restore",
  "revert",
  "rm",
  "checkout",
  "switch",
  "branch",
  "tag"
]);
var MUTATING_GIT_COMMANDS = new Set([
  "add",
  "am",
  "apply",
  "bisect",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "config",
  "fetch",
  "init",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "remote",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
  "worktree"
]);
function findMutatingGitCommand(command) {
  for (const segment of command.split(/\s*(?:&&|\|\||[;|])\s*/)) {
    const tokens = segment.trim().split(/\s+/);
    const gitIndex = tokens.findIndex((token) => token === "git" || token.endsWith("/git"));
    if (gitIndex === -1)
      continue;
    let index = gitIndex + 1;
    while (index < tokens.length && tokens[index].startsWith("-")) {
      const option = tokens[index++];
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"].includes(option)) {
        index++;
      }
    }
    const subcommand = tokens[index];
    if (subcommand && MUTATING_GIT_COMMANDS.has(subcommand))
      return subcommand;
  }
  return;
}
var ALLOWED = { allow: true, reason: "" };
function outsideRepository(workingDirectory) {
  const resolved = resolve(workingDirectory);
  const root = resolve(process.cwd());
  if (resolved === root || resolved.startsWith(root + sep))
    return;
  return `working_directory must stay inside the repository (${root}); '${workingDirectory}' is outside it.`;
}
function checkInvocation(invocation) {
  const cwd = invocation.workingDirectory?.trim();
  if (cwd) {
    const reason = outsideRepository(cwd);
    if (reason)
      return { allow: false, reason };
  }
  const gitCommand = findMutatingGitCommand(invocation.command);
  if (gitCommand) {
    const routed = ROUTED_GIT_COMMANDS.has(gitCommand);
    return {
      allow: false,
      reason: routed ? `Raw 'git ${gitCommand}' is disabled. Use the github__* MCP tools for Git mutations and branch synchronization.` : `Raw 'git ${gitCommand}' is disabled, and there is no MCP tool for it: this run does not do that. ` + `Commit with github__commit_and_push; read-only inspection (status, diff, log) runs normally.`
    };
  }
  const [environPattern, environReason] = PROCESS_ENVIRONMENT_READ;
  if (environPattern.test(invocation.command))
    return { allow: false, reason: environReason };
  for (const [pattern, reason] of ROUTING_RULES) {
    if (pattern.test(invocation.command))
      return { allow: false, reason };
  }
  return ALLOWED;
}
function streakFile() {
  const opsLog = process.env.ATOMA_OPS_LOG;
  if (!opsLog)
    return;
  const dir = opsLog.replace(/[/\\][^/\\]*$/, "");
  return dir === opsLog ? undefined : `${dir}/search-streak`;
}
function readStreak(file) {
  if (!file)
    return 0;
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
function writeStreak(file, streak) {
  if (!file)
    return;
  try {
    writeFileSync(file, String(streak));
  } catch {}
}
function streakRefusal(command) {
  const file = streakFile();
  const streak = nextStreak(readStreak(file), classifyShellAct(command));
  writeStreak(file, streak);
  return refusalReason(streak);
}
async function main() {
  let data;
  try {
    const raw = await new Response(Bun.stdin.stream()).text();
    data = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({ allow: false, reason: "shell_guard: failed to parse input" }));
    return;
  }
  const args = data.arguments ?? {};
  const command = String(args.command ?? args.cmd ?? args.shell ?? "");
  const { allow, reason } = checkInvocation({
    command,
    workingDirectory: typeof args.working_directory === "string" ? args.working_directory : undefined
  });
  const refusal = allow ? streakRefusal(command) : undefined;
  if (refusal !== undefined) {
    console.log(JSON.stringify({ allow: false, reason: `shell_guard: ${refusal}` }));
    return;
  }
  if (allow) {
    console.log(JSON.stringify({ allow: true }));
  } else {
    console.log(JSON.stringify({
      allow: false,
      reason: `Command blocked by shell guard: ${reason} (attempted: ${command.slice(0, 120)})`
    }));
  }
}
if (import.meta.main)
  main();

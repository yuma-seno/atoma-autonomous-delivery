#!/usr/bin/env bun
// @bun

// src/atoma/tools/scripts/hooks/shell_guard.ts
import { resolve, sep } from "path";
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
    return {
      allow: false,
      reason: `Raw 'git ${gitCommand}' is disabled. Use the github__* MCP tools for Git mutations and branch synchronization.`
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

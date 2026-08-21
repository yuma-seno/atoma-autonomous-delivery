#!/usr/bin/env bun
/**
 * shell_guard.ts — Steer the agent to the MCP tool that does the job properly,
 * and refuse the one read that leaks another tool server's credentials.
 *
 * Invoked directly as an executable (not via an interpreter argument) by the
 * Atoma core's `before_tool` hook mechanism, which spawns the configured script
 * path and pipes JSON on stdin. When a command is refused, the reason string is
 * surfaced to the agent as an error, so each reason names the tool to use
 * instead.
 *
 * ## This is NOT a security boundary, and nothing here relies on it being one
 *
 * It is a text match over a shell command line. `a=curl; $a example.com` defeats
 * every rule below, and no amount of pattern work changes that: the shell
 * resolves variables after this hook has already decided. Saying so plainly is
 * the point — a guard that overstates itself makes the person reviewing the pull
 * request review it less carefully.
 *
 * This file used to carry a second layer whose only job was to make the first
 * layer hard to evade: command tokenization to undo `w\get` and `cu""rl`,
 * substitution of declared variables into the text, refusal of `PATH` and
 * `LD_PRELOAD`, and rules against `bash -c`, `eval`, `python -c`, heredocs and
 * `base64 | sh`. All of it is gone, because it was defending a boundary this is
 * not. An agent is not an adversary: it does not obfuscate a command to get past
 * a rule that exists to help it, so evasion resistance bought nothing and cost
 * two thirds of the file.
 *
 * What survives is two kinds of rule, and they are kept apart on purpose because
 * they are not the same kind of thing:
 *
 *   1. ROUTING — commands that would work badly or not at all, where a tool
 *      exists that works properly. Their value is iterations not wasted.
 *   2. HARDENING — exactly one rule, for the one real threat nothing else
 *      covers. Honest about being partial. See PROCESS_ENVIRONMENT_READ.
 */
import { resolve, sep } from "node:path";

/**
 * Commands that have a proper route through an MCP tool.
 *
 * Not prohibitions — redirections. Each reason names the replacement, because
 * the agent reads it and picks again.
 *
 * `gh` is the clearest case, and it is worth knowing it is no longer load
 * bearing for safety: the `shell` server declares no credentials in
 * `tools.yaml`, so `GH_TOKEN` is stripped from it and `gh pr merge` fails with
 * 401 whether or not this rule exists. What the rule saves is the iterations
 * the agent would spend discovering that. The `github__*` tools hold the token
 * and enforce merge readiness; that enforcement lives there, not here.
 */
const ROUTING_RULES: [RegExp, string][] = [
  [
    /\bgh\b/,
    "gh CLI is disabled. Use the atoma_github MCP tools (github__create_pr, github__create_issue, etc.) for GitHub operations.",
  ],
  [/\bcurl\b/, "curl is disabled. Use web__fetch, which returns the page as text."],
  [/\bwget\b/, "wget is disabled. Use web__fetch."],
  [/\bssh\b/, "ssh is disabled: this run works on the checked-out repository, not on other hosts."],
  [/\bscp\b/, "scp is disabled: this run works on the checked-out repository, not on other hosts."],
  [/\brsync\b/, "rsync is disabled: this run works on the checked-out repository, not on other hosts."],
];

/**
 * The one rule that is not routing.
 *
 * Each tool server holds the credentials its `tools.yaml` entry declares, and a
 * process reading `/proc/<pid>/environ` of another server obtains a credential it
 * was deliberately not given.
 *
 * **The structural fix has landed, and this is no longer the thing standing
 * between them.** The servers that hold a credential make themselves
 * non-dumpable, so the kernel refuses the read — measured, and measured with the
 * credential still sitting in the environment block, which is the point: it locks
 * the entry rather than the value. See `../lib/harden.ts`.
 *
 * That replaced a rootless container with its own PID namespace (#374). The
 * container hid the other servers outright, and the reason it went is not that it
 * failed at this: it gave the shell a different filesystem from every other tool,
 * and a write to $HOME inside it succeeded and then was not there for anything
 * else. #464 has the measurements and the three-way trade it comes from.
 *
 * This rule is kept for two cases the flag does not cover. A hand-run `atoma`
 * where a server is an ordinary sibling process. And a THIRD-PARTY server, which
 * cannot be made to harden itself and whose credential is therefore readable —
 * documented as such rather than pretended away.
 *
 * In both it stops an accident and not an intent: `P=/proc; cat $P/1/environ`
 * walks straight past it, exactly as the header says of every rule in this file.
 *
 * So: still worth having, no longer load-bearing. Do not restore a dependency on
 * it.
 *
 * Matched as "both words anywhere" rather than as the literal path. Matching
 * `/proc/<pid>/environ` was the first attempt and its own test broke it:
 * `find /proc -name environ -exec cat {} +` never writes that path, it builds
 * it. The readers are endless too — cat, head, xxd, tr, dd, od, strings, a bare
 * `< /proc/N/environ` — and enumerating either the readers or the spellings is
 * the shape of check this repository has been wrong about three times.
 *
 * `/proc` as a whole stays open: `environ` is the part that matters, and cpuinfo
 * and meminfo have honest uses. `\benviron\b` does not match `environment`, so
 * ordinary words and filenames are unaffected.
 */
const PROCESS_ENVIRONMENT_READ: [RegExp, string] = [
  /^(?=[\s\S]*\/proc)(?=[\s\S]*\benviron\b)/,
  "Reading a process's environment through /proc is disabled: tool servers run as the same user and each holds only the credentials it declares.",
];

/**
 * Git subcommands that change something, as opposed to reporting it.
 *
 * Routing, like the rules above: `github__create_pr` and `github__sync_branch`
 * check that HEAD is pushed and the branch is current before they act, and a
 * worktree the agent mutated by hand is one `create_pr` then refuses. Read-only
 * inspection (`status`, `diff`, `log`, `rev-parse`) is how the agent orients
 * itself and stays allowed.
 */
/**
 * The subset that really does have a github__* replacement, so the refusal can
 * name one truthfully.
 */
const ROUTED_GIT_COMMANDS = new Set([
  "add", "am", "apply", "cherry-pick", "commit", "fetch", "merge", "mv", "pull", "push", "rebase",
  "restore", "revert", "rm", "checkout", "switch", "branch", "tag",
]);

const MUTATING_GIT_COMMANDS = new Set([
  "add", "am", "apply", "bisect", "branch", "checkout", "cherry-pick", "clean", "commit", "config",
  "fetch", "init", "merge", "mv", "pull", "push", "rebase", "remote", "reset", "restore", "revert", "rm",
  "stash", "switch", "tag", "worktree",
]);

/**
 * The mutating git subcommand this command line runs, if any.
 *
 * Splits on shell separators so `cd repo && git push` is seen, and skips git's
 * own options so `git -C repo checkout` resolves to `checkout` rather than to
 * `-C`. Options that take a value consume the next token.
 */
function findMutatingGitCommand(command: string): string | undefined {
  for (const segment of command.split(/\s*(?:&&|\|\||[;|])\s*/)) {
    const tokens = segment.trim().split(/\s+/);
    const gitIndex = tokens.findIndex((token) => token === "git" || token.endsWith("/git"));
    if (gitIndex === -1) continue;

    let index = gitIndex + 1;
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      const option = tokens[index++]!;
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"].includes(option)) {
        index++;
      }
    }
    const subcommand = tokens[index];
    if (subcommand && MUTATING_GIT_COMMANDS.has(subcommand)) return subcommand;
  }
  return undefined;
}

interface ShellInvocation {
  command: string;
  workingDirectory?: string;
}

interface GuardVerdict {
  allow: boolean;
  reason: string;
}

const ALLOWED: GuardVerdict = { allow: true, reason: "" };

/**
 * Why `workingDirectory` is not a place this run needs to go, or undefined.
 *
 * Routing again: the shell tool exists to work on the checked-out repository,
 * and a command that ran somewhere else returns output the agent will read as
 * being about the repository. Confining it is cheaper than explaining the
 * resulting confusion.
 */
function outsideRepository(workingDirectory: string): string | undefined {
  const resolved = resolve(workingDirectory);
  const root = resolve(process.cwd());
  if (resolved === root || resolved.startsWith(root + sep)) return undefined;
  return `working_directory must stay inside the repository (${root}); '${workingDirectory}' is outside it.`;
}

/**
 * Judge one invocation.
 *
 * Not exported: the tests drive this file the way the hook does, by spawning it
 * with JSON on stdin, which exercises the argument parsing in `main` as well. It
 * was exported for tests that called it directly, and those are gone.
 */
function checkInvocation(invocation: ShellInvocation): GuardVerdict {
  const cwd = invocation.workingDirectory?.trim();
  if (cwd) {
    const reason = outsideRepository(cwd);
    if (reason) return { allow: false, reason };
  }

  const gitCommand = findMutatingGitCommand(invocation.command);
  if (gitCommand) {
    // Two different answers, because there are two different situations and the
    // single blanket message sent an agent hunting for a tool that does not
    // exist. `commit`/`push`/`checkout` and the rest of the everyday ones have a
    // route; `config`, `stash`, `clean` and `bisect` do not, and saying so is
    // more useful than naming a family of tools with nothing in it for them.
    const routed = ROUTED_GIT_COMMANDS.has(gitCommand);
    return {
      allow: false,
      reason: routed
        ? `Raw 'git ${gitCommand}' is disabled. Use the github__* MCP tools for Git mutations and branch synchronization.`
        : `Raw 'git ${gitCommand}' is disabled, and there is no MCP tool for it: this run does not do that. `
          + `Commit with github__commit_and_push; read-only inspection (status, diff, log) runs normally.`,
    };
  }

  const [environPattern, environReason] = PROCESS_ENVIRONMENT_READ;
  if (environPattern.test(invocation.command)) return { allow: false, reason: environReason };

  for (const [pattern, reason] of ROUTING_RULES) {
    if (pattern.test(invocation.command)) return { allow: false, reason };
  }
  return ALLOWED;
}

async function main(): Promise<void> {
  let data: { arguments?: Record<string, unknown> };
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
    workingDirectory: typeof args.working_directory === "string" ? args.working_directory : undefined,
  });

  if (allow) {
    console.log(JSON.stringify({ allow: true }));
  } else {
    console.log(
      JSON.stringify({
        allow: false,
        reason: `Command blocked by shell guard: ${reason} (attempted: ${command.slice(0, 120)})`,
      }),
    );
  }
}

if (import.meta.main) main();

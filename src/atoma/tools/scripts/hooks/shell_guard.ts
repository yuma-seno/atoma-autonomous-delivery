#!/usr/bin/env bun
/**
 * shell_guard.ts — Allow read-only inspection, block dangerous commands.
 *
 * Invoked directly as an executable (not via an interpreter argument) by the
 * Atoma core's `before_tool` hook mechanism, which spawns the configured
 * script path and pipes JSON on stdin -- this file's shebang + executable
 * bit make that work the same way shell_guard.py did.
 *
 * When a command is blocked, the output includes a reason string that the
 * MCP shell server surfaces to the AI agent as an error.
 *
 * The blocklist below matches on tokenized, re-joined command text (see
 * `normalizeCommand`) rather than the raw string, so trivial obfuscation
 * like `w\get` or `cu""rl` (which would otherwise slip past a `\bcurl\b`-
 * style regex on the raw text) is normalized back to `wget`/`curl` first.
 * This is still a denylist over shell text, not a sandbox: variable- or
 * command-substitution-based obfuscation (e.g. `a=curl; $a example.com`)
 * is fundamentally out of reach for any static text check and is NOT
 * defended against here.
 */
import { parse } from "shell-quote";

const BLOCKED: [RegExp, string][] = [
  [/\bgh\b/, "gh CLI is disabled. Use the atoma_github MCP tools (github__create_pr, github__create_issue, etc.) for GitHub operations."],
  [/\bcurl\b/, "curl is disabled. Use MCP tools for external data."],
  [/\bwget\b/, "wget is disabled."],
  [/\bssh\b/, "ssh is disabled."],
  [/\bscp\b/, "scp is disabled."],
  [/\brsync\b/, "rsync is disabled."],
  [/\bpython3?\s.*-[cC]\b/, "python -c is disabled."],
  [/\bruby\s.*-[eE]\b/, "ruby -e is disabled."],
  [/\bperl\s.*-[eE]\b/, "perl -e is disabled."],
  [/\bnode\s.*-[eE]\b/, "node -e is disabled."],
  [/\bpython3?\s+<</, "python heredoc is disabled."],
  [/\bruby\s+<</, "ruby heredoc is disabled."],
  [/\bperl\s+<</, "perl heredoc is disabled."],
  [/\bnode\s+<</, "node heredoc is disabled."],
  [/\bbase64\b.*\|\s*(?:sh|bash|zsh|dash)/, "base64 pipe-to-shell is disabled."],
  [/\bxxd\b.*\|\s*(?:sh|bash|zsh|dash)/, "binary pipe-to-shell is disabled."],
  [/(?:^|\s|\||;)\beval\b/, "eval is disabled."],
  [/(?:^|\s|\||;)\bexec\b/, "exec is disabled."],
  [/(?:^|\s|;)\bsource\b/, "source is disabled."],
  [/(?:^|\s|\||;)\.\s+/, "source (.) is disabled."],
  [/\bsh\s+(?:-[a-zA-Z]+\s+)*-c\b/, "sh -c is disabled."],
  [/\bbash\s+(?:-[a-zA-Z]+\s+)*-c\b/, "bash -c is disabled."],
  [/\bzsh\s+(?:-[a-zA-Z]+\s+)*-c\b/, "zsh -c is disabled."],
  [/\bdash\s+(?:-[a-zA-Z]+\s+)*-c\b/, "dash -c is disabled."],
];

const MUTATING_GIT_COMMANDS = new Set([
  "add", "am", "apply", "bisect", "branch", "checkout", "cherry-pick", "clean", "commit", "config",
  "fetch", "init", "merge", "mv", "pull", "push", "rebase", "remote", "reset", "restore", "revert", "rm",
  "stash", "switch", "tag", "worktree",
]);

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

/**
 * Tokenizes `command` with `shell-quote` (resolving backslash escapes and
 * quote-splicing the way a real shell would) and re-joins it into a plain
 * string, gluing consecutive operator tokens (e.g. the two `<` tokens a
 * heredoc's `<<` parses into) back together so the BLOCKED regexes above
 * -- written against normal shell syntax -- still match. Falls back to the
 * raw string if parsing throws (malformed input is at least no *less* safe
 * than the pre-existing raw-string check).
 */
function normalizeCommand(command: string): string {
  let tokens: unknown[];
  try {
    tokens = parse(command);
  } catch {
    return command;
  }

  let out = "";
  let prevWasOp = false;
  for (const t of tokens) {
    const isOp = typeof t !== "string";
    const text = isOp ? (t as { op: string }).op : (t as string);
    if (out.length === 0) out = text;
    else if (isOp && prevWasOp) out += text;
    else out += ` ${text}`;
    prevWasOp = isOp;
  }
  return out;
}

function checkCommand(command: string): { allow: boolean; reason: string } {
  const normalized = normalizeCommand(command);
  const gitCommand = findMutatingGitCommand(normalized);
  if (gitCommand) {
    return {
      allow: false,
      reason: `Raw 'git ${gitCommand}' is disabled. Use the github__* MCP tools for Git mutations and branch synchronization.`,
    };
  }
  for (const [pattern, reason] of BLOCKED) {
    if (pattern.test(normalized)) return { allow: false, reason };
  }
  return { allow: true, reason: "" };
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
  const { allow, reason } = checkCommand(command);

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

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
 *
 * ## The guard judges the whole invocation, not the `command` field
 *
 * `shell__execute` takes four arguments that reach `bash`, and this used to read
 * only the first. The other three each defeated the denylist outright, because
 * the shell server passes them straight to `Bun.spawn` (see `mcp/shell.ts`):
 *
 *   - `working_directory` becomes `cwd`, so `{command: "cat environ",
 *     working_directory: "/proc/1"}` reads a path that never appears in the
 *     command text. Any rule written against a path is bypassed by moving the
 *     path into this field.
 *   - `environment_variables` is merged into the child's environment, so
 *     `{command: "cat $P/1/environ", environment_variables: {P: "/proc"}}`
 *     supplies exactly the variable expansion the header above calls out of
 *     reach -- from the schema, not from the shell.
 *   - `input_data` is piped to stdin, so `{command: "bash"}` with a script in
 *     `input_data` runs that script. `bash -c` is blocked; a bare interpreter
 *     reading stdin was not.
 *
 * So each is now accounted for: the working directory is confined, declared
 * variables are substituted into the text before matching (which makes the
 * command MORE legible to the rules, not less), and a bare interpreter fed on
 * stdin is treated as the `-c` it is equivalent to.
 */
import { resolve, sep } from "node:path";
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

/**
 * Variables whose value decides what a command actually executes.
 *
 * Setting any of these turns an allowed command line into an arbitrary one --
 * `PATH` re-points every bare binary name, `LD_PRELOAD` injects code into every
 * process started, `BASH_ENV` names a file bash sources before running. No text
 * rule can see that, so these are refused rather than inspected.
 */
const EXECUTION_CONTROLLING_VARS = new Set([
  "BASH_ENV",
  "ENV",
  "IFS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "PATH",
  "SHELL",
  "SHELLOPTS",
]);

/** Interpreters that run whatever arrives on stdin, making `input_data` a script. */
const STDIN_INTERPRETERS = /^(?:[\w./-]*\/)?(?:sh|bash|zsh|dash|python3?|ruby|perl|node|bun)$/;

/**
 * Substitute declared variables into the command so the rules can see through
 * them. `{P: "/proc"}` turns `cat $P/1/environ` into `cat /proc/1/environ`.
 *
 * Longest name first, so `$FOO` is not partly replaced by a shorter `$F`.
 */
function substituteDeclaredVars(command: string, vars: Record<string, string>): string {
  let out = command;
  for (const name of Object.keys(vars).sort((a, b) => b.length - a.length)) {
    if (!/^\w+$/.test(name)) continue;
    out = out.split(`\${${name}}`).join(vars[name] ?? "");
    out = out.split(`$${name}`).join(vars[name] ?? "");
  }
  return out;
}

export interface ShellInvocation {
  command: string;
  workingDirectory?: string;
  environmentVariables?: Record<string, string>;
  inputData?: string;
}

/**
 * Judge the whole invocation.
 *
 * Exported for the tests, which exercise the three argument channels directly
 * rather than only through the process boundary.
 */
export function checkInvocation(invocation: ShellInvocation): { allow: boolean; reason: string } {
  const vars = invocation.environmentVariables ?? {};

  for (const name of Object.keys(vars)) {
    if (EXECUTION_CONTROLLING_VARS.has(name.toUpperCase())) {
      return {
        allow: false,
        reason: `Setting ${name} through environment_variables is disabled: it changes what the command executes, which no inspection of the command text can account for.`,
      };
    }
  }

  // Confined rather than inspected. A rule about a path cannot help if the path
  // arrives here instead of in the command, and the shell tool exists to work on
  // this repository -- somewhere outside it is not a place it needs to run.
  const cwd = invocation.workingDirectory?.trim();
  if (cwd) {
    const resolved = resolve(cwd);
    const root = resolve(process.cwd());
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return {
        allow: false,
        reason: `working_directory must stay inside the repository (${root}); '${cwd}' is outside it.`,
      };
    }
  }

  // A bare interpreter with a script on stdin is `-c` by another route.
  if (invocation.inputData !== undefined) {
    const first = normalizeCommand(invocation.command).trim().split(/\s+/)[0] ?? "";
    if (STDIN_INTERPRETERS.test(first)) {
      return {
        allow: false,
        reason: `Piping a script into '${first}' through input_data is disabled, for the same reason '${first} -c' is.`,
      };
    }
  }

  // Everything that reaches bash gets matched: the command with its declared
  // variables resolved, and the stdin text, which a non-interpreter command may
  // still act on.
  const text = [substituteDeclaredVars(invocation.command, vars), invocation.inputData ?? ""]
    .filter(Boolean)
    .join("\n");
  return checkCommand(text);
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
  const { allow, reason } = checkInvocation({
    command,
    workingDirectory: typeof args.working_directory === "string" ? args.working_directory : undefined,
    environmentVariables:
      args.environment_variables && typeof args.environment_variables === "object"
        ? (args.environment_variables as Record<string, string>)
        : undefined,
    inputData: typeof args.input_data === "string" ? args.input_data : undefined,
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

#!/usr/bin/env python3
"""shell_guard.py — Allow git, block dangerous commands.

When a command is blocked, the output includes a reason string
that the MCP shell server surfaces to the AI agent as an error.
"""
import json
import re
import sys

BLOCKED = [
    (r'\bgh\b', "gh CLI is disabled. Use the atoma_github MCP tools (github__create_pr, github__create_issue, etc.) for GitHub operations."),
    (r'\bcurl\b', "curl is disabled. Use MCP tools for external data."),
    (r'\bwget\b', "wget is disabled."),
    (r'\bssh\b', "ssh is disabled."),
    (r'\bscp\b', "scp is disabled."),
    (r'\brsync\b', "rsync is disabled."),
    (r'\bpython3?\s.*-[cC]\b', "python -c is disabled."),
    (r'\bruby\s.*-[eE]\b', "ruby -e is disabled."),
    (r'\bperl\s.*-[eE]\b', "perl -e is disabled."),
    (r'\bnode\s.*-[eE]\b', "node -e is disabled."),
    (r'\bpython3?\s+<<', "python heredoc is disabled."),
    (r'\bruby\s+<<', "ruby heredoc is disabled."),
    (r'\bperl\s+<<', "perl heredoc is disabled."),
    (r'\bnode\s+<<', "node heredoc is disabled."),
    (r'\bbase64\b.*\|\s*(?:sh|bash|zsh|dash)', "base64 pipe-to-shell is disabled."),
    (r'\bxxd\b.*\|\s*(?:sh|bash|zsh|dash)', "binary pipe-to-shell is disabled."),
    (r'(?:^|\s|\||\;)\beval\b', "eval is disabled."),
    (r'(?:^|\s|\||\;)\bexec\b', "exec is disabled."),
    (r'(?:^|\s|\;)\bsource\b', "source is disabled."),
    (r'(?:^|\s|\;)\.\s', "source (.) is disabled."),
    (r'\bsh\s+(?:-[a-zA-Z]+\s+)*-c\b', "sh -c is disabled."),
    (r'\bbash\s+(?:-[a-zA-Z]+\s+)*-c\b', "bash -c is disabled."),
    (r'\bzsh\s+(?:-[a-zA-Z]+\s+)*-c\b', "zsh -c is disabled."),
    (r'\bdash\s+(?:-[a-zA-Z]+\s+)*-c\b', "dash -c is disabled."),
]
COMPILED = [(re.compile(pattern, re.MULTILINE), reason) for pattern, reason in BLOCKED]


def check_command(command: str) -> tuple[bool, str]:
    for pattern, reason in COMPILED:
        if pattern.search(command):
            return False, reason
    return True, ""


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        print(json.dumps({"allow": False, "reason": "shell_guard: failed to parse input"}))
        return

    arguments = data.get("arguments", {})
    command = arguments.get("command") or arguments.get("cmd") or arguments.get("shell") or ""
    allow, reason = check_command(command)
    if allow:
        print(json.dumps({"allow": True}))
    else:
        # The reason is surfaced to the AI as a tool error, so include a helpful hint
        print(json.dumps({
            "allow": False,
            "reason": (
                f"Command blocked by shell guard: {reason} "
                f"(attempted: {command[:120]})"
            )
        }))


if __name__ == "__main__":
    main()

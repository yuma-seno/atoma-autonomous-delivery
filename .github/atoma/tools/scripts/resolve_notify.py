#!/usr/bin/env python3
"""Resolve who to notify (a GitHub login) for a given issue or PR.

Looks for an `<!-- atoma:notify=LOGIN -->` tag in the body -- embedded by
atoma_github_mcp_server.py when the agent that created the issue/PR knew who
the original human requester was (see ISSUE_NOTIFY / _notify_tag_prefix).

Falls back to the issue/PR's own author when no tag is present and the
author is a human. This covers root issues, which are opened directly by a
human and therefore never carry the tag themselves (only bot-created
sub-issues and PRs do).

If neither is available (e.g. the author is a bot and there is no notify
tag -- typically an issue/PR created before this propagation existed, or a
dispatch path that failed to set ISSUE_NOTIFY), walks up the
`atoma:parent=#N` / `atoma:parent-issue=N` chain and retries on the parent,
since every sub-issue/PR is ultimately rooted in an issue a human opened
directly. Gives up after MAX_HOPS to guard against cycles/self-references.

Uses the generic `issues` REST endpoint (not `gh issue view`/`gh pr view`),
since GitHub treats every PR as an issue under the hood -- this lets a
single lookup work for both --type issue and --type pr numbers.

Usage:
    resolve_notify.py --repo OWNER/REPO --number N
Prints the resolved login (possibly empty) to stdout. Never raises for
missing data -- callers treat an empty result as "nobody to notify".
"""
import argparse
import json
import re
import subprocess

NOTIFY_RE = re.compile(r"<!--\s*atoma:notify=([A-Za-z0-9-]+)\s*-->")
PARENT_RE = re.compile(r"<!--\s*atoma:parent(?:-issue)?=#?(\d+)\s*-->")

MAX_HOPS = 10


def gh_json(*args):
    try:
        out = subprocess.run(
            ["gh", *args], capture_output=True, text=True, check=True
        ).stdout
        return json.loads(out) if out.strip() else {}
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return {}


def fetch(repo: str, number: int) -> dict:
    return gh_json(
        "api", f"repos/{repo}/issues/{number}",
        "--jq", "{body: .body, login: .user.login, type: .user.type}",
    )


def resolve(repo: str, number: int) -> str:
    """Resolve the notify login for `number`, walking up parent tags as needed."""
    visited = set()
    current = number
    for _ in range(MAX_HOPS):
        if current in visited:
            break  # cycle guard
        visited.add(current)

        d = fetch(repo, current)
        body = d.get("body") or ""

        match = NOTIFY_RE.search(body)
        if match:
            return match.group(1)

        if (d.get("type") or "").lower() == "user":
            login = d.get("login") or ""
            if login:
                return login

        parent_match = PARENT_RE.search(body)
        if not parent_match:
            break
        current = int(parent_match.group(1))

    return ""


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--number", required=True, type=int)
    args = p.parse_args()

    print(resolve(args.repo, args.number))


if __name__ == "__main__":
    main()

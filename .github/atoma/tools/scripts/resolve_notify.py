#!/usr/bin/env python3
"""Resolve who to notify (a GitHub login) for a given issue.

Looks for an `<!-- atoma:notify=LOGIN -->` tag in the issue body -- embedded
by atoma_github_mcp_server.py when the agent that created the issue knew who
the original human requester was (see ISSUE_NOTIFY / _notify_tag_prefix).

Falls back to the issue's own author when no tag is present and the author
is a human. This covers root issues, which are opened directly by a human
and therefore never carry the tag themselves (only bot-created sub-issues
and PRs do).

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


def gh_json(*args):
    try:
        out = subprocess.run(
            ["gh", *args], capture_output=True, text=True, check=True
        ).stdout
        return json.loads(out) if out.strip() else {}
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return {}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--number", required=True, type=int)
    args = p.parse_args()

    d = gh_json(
        "issue", "view", str(args.number), "--repo", args.repo,
        "--json", "body,author",
    )
    body = d.get("body") or ""
    match = NOTIFY_RE.search(body)
    if match:
        print(match.group(1))
        return

    author = d.get("author") or {}
    if (author.get("type") or "").upper() == "USER":
        login = author.get("login") or ""
        if login:
            print(login)
            return

    print("")


if __name__ == "__main__":
    main()

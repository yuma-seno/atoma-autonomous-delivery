#!/usr/bin/env python3
"""
inject_sub_results.py — Replace the last tool message in a session JSON with
aggregated sub-issue completion results.

Usage:
  python3 inject_sub_results.py \\
    --session session.json \\
    --repo OWNER/REPO \\
    --parent N \\
    --sub-issues 2,3,4 \\
    --out session.json

Reads the session, finds the last ``role: "tool"`` message (the one left by
``launch_sub_agent``), and replaces its content with an aggregated result
summarizing the completed sub-issues and their linked PRs.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any


def find_last_tool_index(messages: list[dict[str, Any]]) -> int | None:
    """Return the index of the last message with role='tool', or None."""
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "tool":
            return i
    return None


def gather_sub_results(repo: str, sub_issues: list[int]) -> str:
    """Query GitHub for each sub-issue's linked PRs and build a summary."""
    lines: list[str] = []
    lines.append("All sub-issues have been completed.")
    lines.append("")
    lines.append("## Sub-issue Results")
    lines.append("")

    for num in sub_issues:
        try:
            # Get issue title and linked PRs
            result = subprocess.run(
                [
                    "gh", "issue", "view", str(num),
                    "--repo", repo,
                    "--json", "title,state,closedAt",
                ],
                capture_output=True, text=True, timeout=15,
            )
            issue_info = json.loads(result.stdout) if result.returncode == 0 else {}
            title = issue_info.get("title", "Unknown")
            state = issue_info.get("state", "closed")
            closed_at = issue_info.get("closedAt", "N/A")
        except Exception:
            title = "Unknown"
            state = "closed"
            closed_at = "N/A"

        # Find PRs linked to this sub-issue
        linked_prs: list[str] = []
        try:
            pr_result = subprocess.run(
                [
                    "gh", "pr", "list",
                    "--repo", repo,
                    "--state", "merged",
                    "--search", f"#{num} in:body",
                    "--json", "number,title,url",
                ],
                capture_output=True, text=True, timeout=15,
            )
            if pr_result.returncode == 0:
                prs = json.loads(pr_result.stdout) or []
                for pr in prs:
                    linked_prs.append(f"- PR #{pr['number']}: {pr['title']} ({pr['url']})")
        except Exception:
            pass

        # Also check open PRs
        try:
            pr_result2 = subprocess.run(
                [
                    "gh", "pr", "list",
                    "--repo", repo,
                    "--state", "open",
                    "--search", f"#{num} in:body",
                    "--json", "number,title,url",
                ],
                capture_output=True, text=True, timeout=15,
            )
            if pr_result2.returncode == 0:
                prs2 = json.loads(pr_result2.stdout) or []
                for pr in prs2:
                    linked_prs.append(f"- PR #{pr['number']}: {pr['title']} ({pr['url']})")
        except Exception:
            pass

        lines.append(f"### #{num}: {title}")
        lines.append(f"Status: {state}")

        if linked_prs:
            lines.append("Linked PRs:")
            lines.extend(linked_prs)
        else:
            lines.append("No linked PRs found.")

        lines.append("")

    lines.append("---")
    lines.append("All sub-issues are complete. Please review the results and aggregate them into a final summary.")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Inject aggregated sub-issue results into a session JSON",
    )
    parser.add_argument("--session", required=True, help="Path to session.json")
    parser.add_argument("--repo", required=True, help="GitHub repo (OWNER/REPO)")
    parser.add_argument("--parent", required=True, type=int, help="Parent issue number")
    parser.add_argument("--sub-issues", required=True, help="Comma-separated sub-issue numbers")
    parser.add_argument("--out", required=True, help="Output path for modified session.json")
    args = parser.parse_args()

    # Parse sub-issue numbers
    sub_issues = [int(x.strip()) for x in args.sub_issues.split(",") if x.strip()]

    # Load session
    with open(args.session, "r") as f:
        session = json.load(f)

    messages: list[dict[str, Any]] = session.get("messages", [])
    last_tool_idx = find_last_tool_index(messages)

    if last_tool_idx is None:
        print("No tool message found in session. Appending as user message.", file=sys.stderr)
        # Fallback: append as user message
        summary = gather_sub_results(args.repo, sub_issues)
        messages.append({
            "role": "user",
            "content": summary,
        })
    else:
        # Replace the last tool message content
        summary = gather_sub_results(args.repo, sub_issues)
        messages[last_tool_idx]["content"] = summary

    session["messages"] = messages

    # Write output
    with open(args.out, "w") as f:
        json.dump(session, f, indent=2)

    print(f"Session updated: replaced tool message at index {last_tool_idx}", file=sys.stderr)
    print(f"Output written to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()

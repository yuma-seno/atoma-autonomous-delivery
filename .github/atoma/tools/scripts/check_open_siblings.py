#!/usr/bin/env python3
"""Count open sub-issues (siblings) still linked to a parent issue.

Shared by atoma-pr-merged.yml and atoma-sub-issue-closed.yml to decide
whether all sub-tasks of an orchestrated parent issue are done before
re-invoking the orchestrator.

Usage:
  check_open_siblings.py --repo OWNER/REPO --parent N [--label LABEL]

Prints the number of still-open sibling issues to stdout.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from atoma_config import get_label


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True, help="OWNER/REPO")
    p.add_argument("--parent", required=True, type=int)
    p.add_argument(
        "--label", default=None, help="Override the sub_issue label from config.json"
    )
    p.add_argument(
        "--launched-label",
        default=None,
        help="Override the launched label from config.json",
    )
    args = p.parse_args()

    label = args.label or get_label("sub_issue", "atoma/sub-issue")
    launched_label = args.launched_label or get_label("launched", "atoma/launched")

    # Only count siblings that have actually been dispatched (labeled "launched").
    # Sub-issues created but not yet launched (e.g. a later phase in a
    # dependency-ordered plan) must NOT block re-invocation of the orchestrator,
    # otherwise the count can never reach zero and the orchestrator would never
    # be re-invoked to launch the next phase.
    result = subprocess.run(
        [
            "gh", "issue", "list",
            "--repo", args.repo,
            "--state", "open",
            "--label", label,
            "--label", launched_label,
            "--search", f"atoma:parent=#{args.parent} in:body",
            "--json", "number",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(
            f"check_open_siblings: gh issue list failed: {result.stderr.strip()}",
            file=sys.stderr,
        )
        sys.exit(1)

    siblings = json.loads(result.stdout or "[]")
    print(len(siblings))


if __name__ == "__main__":
    main()

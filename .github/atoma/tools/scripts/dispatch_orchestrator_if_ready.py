#!/usr/bin/env python3
"""
dispatch_orchestrator_if_ready.py — After a sub-issue closes, check whether all
of its siblings (sharing the same <!-- atoma:parent=#N --> tag) are also done,
and if so, re-invoke the orchestrator on the parent issue for aggregation.

Standalone (not inlined in atoma_github_mcp_server.py) so multiple close paths
can trigger the exact same phase-gating logic without duplicating it:
  - atoma_github_mcp_server.py's _close_issue (the normal merge_pr-driven path
    and the origin-agent re-invocation confirmation path)
  - request_close_issue.sh (invoked by atoma_mcp_server.py's
    atoma__request_close_issue tool, used by the orchestrator)

Normally this decision is made by atoma-pr-merged.yml / atoma-sub-issue-closed.yml,
triggered by the pull_request_target/issues GitHub events. But those events are
NEVER delivered for actions taken with the Actions GITHUB_TOKEN (this process's
own `gh issue close` calls) -- GitHub explicitly suppresses event cascades from
the default token to prevent recursive workflow runs. So under merge_policy:
"auto" neither workflow ever fires, and the aggregation logic would silently
never run. `gh workflow run` (workflow_dispatch) is explicitly exempted from
that suppression, so replicate the sibling-check-and-dispatch here instead of
relying on the event-triggered workflows.

Usage:
    dispatch_orchestrator_if_ready.py --repo OWNER/REPO --issue N
Best-effort: never raises, just logs progress to stderr and returns.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def gh_json(*args):
    rc, out, _ = gh(*args)
    if rc or not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def log(msg):
    print(f"[dispatch-orchestrator-if-ready] {msg}", file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--issue", required=True)
    args = parser.parse_args()

    repo = args.repo
    sub_issue_num = args.issue
    scripts_dir = os.path.dirname(os.path.abspath(__file__))

    d = gh_json("issue", "view", sub_issue_num, "--repo", repo, "--json", "body")
    body = (d or {}).get("body") or ""
    m = re.search(r"<!--\s*atoma:parent=#(\d+)\s*-->", body)
    if not m:
        log(f"issue #{sub_issue_num} has no atoma:parent tag, nothing to do")
        return
    parent_num = m.group(1)

    # gh issue list --search relies on GitHub's search index, which is only
    # eventually consistent -- the issue we just closed a moment ago may still
    # be reported as open for a second or two. Retry a few times with a short
    # backoff before trusting a non-zero count, otherwise this races and
    # under-counts correctly-closed siblings as still open, silently skipping
    # dispatch.
    sibling_count = None
    for attempt in range(4):
        if attempt:
            time.sleep(2 * attempt)
        count_out = subprocess.run(
            ["python3", os.path.join(scripts_dir, "check_open_siblings.py"),
             "--repo", repo, "--parent", parent_num],
            capture_output=True, text=True,
        )
        if count_out.returncode != 0:
            log(f"check_open_siblings failed: {count_out.stderr.strip()}")
            return
        try:
            sibling_count = int((count_out.stdout or "0").strip())
        except ValueError:
            log(f"unexpected sibling count output: {count_out.stdout!r}")
            return
        if sibling_count == 0:
            break
        log(f"attempt {attempt + 1}: {sibling_count} sibling(s) of #{parent_num} still open (may be search-index lag), retrying")
    if sibling_count:
        log(f"{sibling_count} sibling(s) of #{parent_num} still open after retries, not dispatching")
        return

    # atoma-runner.yml only actually runs the agent when new_event_count != '0'
    # (build_context_session.py's change-detection gate). A bare `gh workflow
    # run` with nothing new posted on the parent issue itself would dispatch a
    # run that immediately no-ops as "skipped" -- confirmed empirically. Post a
    # visible completion comment first so the orchestrator's next invocation
    # sees a genuinely new event.
    rc, out, err = gh(
        "issue", "comment", parent_num, "--repo", repo,
        "--body", f"All sub-tasks completed (last: #{sub_issue_num}). Re-invoking orchestrator for aggregation.",
    )
    if rc:
        log(f"could not post trigger comment on #{parent_num}: {err or out}")

    notify_out = subprocess.run(
        ["python3", os.path.join(scripts_dir, "resolve_notify.py"),
         "--repo", repo, "--number", parent_num],
        capture_output=True, text=True,
    )
    notify = (notify_out.stdout or "").strip()
    log(f"all siblings of #{parent_num} done, dispatching orchestrator")
    rc, out, err = gh(
        "workflow", "run", "atoma-runner.yml",
        "--repo", repo,
        "--field", "agent=orchestrator",
        "--field", f"number={parent_num}",
        "--field", "type=issue",
        "--field", f"notify={notify}",
    )
    if rc:
        log(f"gh workflow run failed (rc={rc}): {err or out}")


if __name__ == "__main__":
    main()

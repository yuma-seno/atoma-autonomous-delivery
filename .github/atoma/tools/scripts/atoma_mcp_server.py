#!/usr/bin/env python3
"""
atoma_mcp_server.py — MCP server exposing Atoma orchestration tools.

Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
Dependencies: Python stdlib only (no pip install needed).

Tools:
  - launch_sub_agent: Launch an Atoma agent on a sub-issue and end the
    orchestrator session.

When launch_sub_agent is called, the response includes `session_ends: true`
so the Atoma core can detect that the orchestrator session should terminate.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any


SCRIPT_DIR = os.environ.get(
    "ATOMA_SCRIPTS_DIR",
    os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), ".github/atoma/tools/scripts"),
)

TOOLS = [
    {
        "name": "launch_sub_agent",
        "description": (
            "Dispatch Atoma agents onto sub-issues and immediately end the orchestrator session. "
            "Call this ONCE after creating all sub-issues via GitHub MCP. "
            "Each sub-issue can be assigned a different agent. "
            "The orchestrator session ends immediately after this call returns. "
            "The orchestrator will be automatically re-invoked when ALL sub-issues are closed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "issue": {
                                "type": "integer",
                                "description": "The sub-issue number.",
                            },
                            "agent": {
                                "type": "string",
                                "description": "The agent to dispatch (e.g., 'engineer').",
                            },
                        },
                        "required": ["issue", "agent"],
                    },
                    "description": "List of {issue, agent} pairs to dispatch.",
                },
            },
            "required": ["tasks"],
        },
    },
    {
        "name": "request_close_issue",
        "description": (
            "Conclude work on YOUR CURRENT issue and end your session. This is the ONLY "
            "correct way for the orchestrator to finish an issue -- do NOT call "
            "github__close_issue yourself, and do NOT just stop responding without calling "
            "this. The tool decides what happens next based on who opened THIS issue: "
            "if it was created by another Atoma agent (a sub-issue), it is closed "
            "automatically right now and phase-gating/aggregation is triggered for its "
            "parent. If it was opened directly by a human (a root issue), it is NOT "
            "closed -- instead a comment mentioning that human is posted with your reason "
            "and summary, asking them to review and close it themselves."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why this issue's work is considered complete.",
                },
                "summary": {
                    "type": "string",
                    "description": "Final summary to include in the posted comment (e.g. an aggregation report).",
                },
            },
            "required": ["reason"],
        },
    },
]

SERVER_INFO = {
    "name": "atoma-mcp-server",
    "version": "1.0.0",
}


def log(msg: str) -> None:
    """Log to stderr so it doesn't interfere with stdio protocol."""
    print(f"[atoma-mcp] {msg}", file=sys.stderr, flush=True)


def send_response(request_id: Any, result: Any) -> None:
    """Send a JSON-RPC 2.0 success response to stdout."""
    response = {"jsonrpc": "2.0", "id": request_id, "result": result}
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()


def send_error(request_id: Any, code: int, message: str) -> None:
    """Send a JSON-RPC 2.0 error response to stdout."""
    response = {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()


def handle_initialize(params: dict[str, Any], request_id: Any) -> None:
    send_response(request_id, {
        "protocolVersion": "2024-11-05",
        "capabilities": {"tools": {}},
        "serverInfo": SERVER_INFO,
    })


def handle_tools_list(_params: dict[str, Any], request_id: Any) -> None:
    send_response(request_id, {"tools": TOOLS})


def handle_tools_call(params: dict[str, Any], request_id: Any) -> None:
    tool_name = params.get("name", "")
    arguments = params.get("arguments", {})

    if tool_name == "request_close_issue":
        handle_request_close_issue(arguments, request_id)
        return

    if tool_name != "launch_sub_agent":
        send_error(request_id, -32601, f"Unknown tool: {tool_name}")
        return

    tasks = arguments.get("tasks", [])

    # Validate
    if not isinstance(tasks, list) or len(tasks) == 0:
        send_error(request_id, -32602, f"tasks must be a non-empty list of {{issue, agent}} objects, got: {tasks}")
        return
    for t in tasks:
        if not isinstance(t, dict):
            send_error(request_id, -32602, f"Each task must be an object, got: {t}")
            return
        issue = t.get("issue")
        agent = t.get("agent")
        if not isinstance(issue, int) or issue <= 0:
            send_error(request_id, -32602, f"Each task.issue must be a positive integer, got: {issue}")
            return
        if not isinstance(agent, str) or not agent:
            send_error(request_id, -32602, f"Each task.agent must be a string, got: {agent}")
            return

    log(f"Dispatching {len(tasks)} sub-issue(s): {tasks}")

    # The orchestrator's OWN current issue (the parent, from the sub-issues'
    # point of view). Captured before the dispatch loop -- each iteration below
    # only overrides ISSUE_NUMBER in the *subprocess's* env dict, never in this
    # process's actual os.environ, so this stays stable throughout.
    parent_issue = os.environ.get("ISSUE_NUMBER", "").strip()

    script = os.path.join(SCRIPT_DIR, "launch_sub_agent.sh")
    if not os.path.isfile(script):
        send_error(request_id, -32603, f"Script not found: {script}")
        return

    dispatched = []
    errors = []

    for t in tasks:
        issue = t["issue"]
        agent = t["agent"]
        try:
            result = subprocess.run(
                ["bash", script, "--issue", str(issue), "--agent", agent],
                capture_output=True,
                text=True,
                timeout=30,
                env={**os.environ, "ISSUE_NUMBER": str(issue)},
            )

            if result.returncode != 0:
                log(f"Script failed for #{issue} (exit {result.returncode}): {result.stderr}")
                errors.append(f"#{issue}/{agent}: {result.stderr.strip() or 'unknown error'}")
            else:
                log(f"Script output for #{issue}: {result.stdout.strip()}")
                dispatched.append(f"#{issue}→{agent}")

        except subprocess.TimeoutExpired:
            errors.append(f"#{issue}/{agent}: timed out after 30s")
        except OSError as e:
            errors.append(f"#{issue}/{agent}: {e}")

    # Best-effort comment on the PARENT issue (not just each sub-issue) so a
    # human reading the parent's thread has a full audit trail of what was
    # dispatched without needing to open every sub-issue individually.
    if dispatched and parent_issue:
        try:
            body_lines = ["Atoma: Launched sub-agent(s):"] + [f"- {d}" for d in dispatched]
            subprocess.run(
                ["gh", "issue", "comment", parent_issue, "--body", "\n".join(body_lines)],
                capture_output=True, text=True, timeout=15,
            )
        except (subprocess.TimeoutExpired, OSError) as e:
            log(f"Failed to post dispatch summary comment on parent #{parent_issue}: {e}")

    if errors and not dispatched:
        send_error(request_id, -32603, f"All dispatches failed: {'; '.join(errors)}")
        return

    summary_lines = [f"Dispatch comments posted for {len(dispatched)} sub-issue(s): {', '.join(dispatched)}."]
    if errors:
        summary_lines.append(f"Warning: {len(errors)} failed: {'; '.join(errors)}")
    summary_lines.append("")
    summary_lines.append("Agents will be dispatched automatically. The orchestrator session will now end.")
    summary_lines.append("It will resume automatically when all sub-issues are closed.")

    send_response(request_id, {
        "content": [
            {
                "type": "text",
                "text": "\n".join(summary_lines),
            }
        ],
        "isError": False,
        "_meta": {
            "session_ends": True,
        },
    })


def handle_request_close_issue(arguments: dict[str, Any], request_id: Any) -> None:
    reason = (arguments.get("reason") or "").strip()
    summary = (arguments.get("summary") or "").strip()

    if not reason:
        send_error(request_id, -32602, "reason must be a non-empty string")
        return

    issue_number = os.environ.get("ISSUE_NUMBER", "").strip()
    if not issue_number:
        send_error(request_id, -32603, "ISSUE_NUMBER is not set in the environment")
        return

    script = os.path.join(SCRIPT_DIR, "request_close_issue.sh")
    if not os.path.isfile(script):
        send_error(request_id, -32603, f"Script not found: {script}")
        return

    cmd = ["bash", script, "--issue", issue_number, "--reason", reason]
    if summary:
        cmd += ["--summary", summary]

    log(f"Concluding issue #{issue_number}: reason={reason!r}")

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        send_error(request_id, -32603, f"request_close_issue.sh timed out for #{issue_number}")
        return
    except OSError as e:
        send_error(request_id, -32603, f"Failed to run request_close_issue.sh: {e}")
        return

    if result.returncode != 0:
        log(f"request_close_issue.sh failed for #{issue_number} (exit {result.returncode}): {result.stderr}")
        send_error(
            request_id, -32603,
            f"Failed to conclude issue #{issue_number}: {result.stderr.strip() or 'unknown error'}",
        )
        return

    output = result.stdout.strip()
    log(f"request_close_issue.sh output for #{issue_number}: {output}")

    if output.startswith("closed:"):
        text = (
            f"Issue #{issue_number} was created by an Atoma agent (a sub-issue) and has "
            "been closed automatically. Phase-gating/aggregation for its parent has been checked."
        )
    else:
        text = (
            f"Issue #{issue_number} was opened directly by a human. It has NOT been closed "
            "automatically -- a comment mentioning them was posted with your reason/summary, "
            "asking them to review and close it themselves."
        )

    send_response(request_id, {
        "content": [
            {
                "type": "text",
                "text": text,
            }
        ],
        "isError": False,
        "_meta": {
            "session_ends": True,
        },
    })


METHOD_HANDLERS = {
    "initialize": handle_initialize,
    "tools/list": handle_tools_list,
    "tools/call": handle_tools_call,
}


def main() -> None:
    log("Starting atoma-mcp-server (stdio transport)")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            message = json.loads(line)
        except json.JSONDecodeError as e:
            log(f"Invalid JSON: {e}")
            continue

        method = message.get("method", "")
        request_id = message.get("id")
        params = message.get("params", {})

        log(f"Received: {method} (id={request_id})")

        handler = METHOD_HANDLERS.get(method)
        if handler is None:
            # Skip notifications (no id)
            if request_id is not None:
                send_error(request_id, -32601, f"Method not found: {method}")
            continue

        try:
            handler(params, request_id)
        except Exception as e:
            log(f"Handler error for {method}: {e}")
            if request_id is not None:
                send_error(request_id, -32603, f"Internal error: {e}")


if __name__ == "__main__":
    main()

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
            "Launch Atoma agents on a list of sub-issues and immediately end the orchestrator session. "
            "Call this ONCE after creating all sub-issues via GitHub MCP. "
            "Pass ALL sub-issue numbers in a single call. "
            "The orchestrator session ends immediately after this call returns. "
            "The orchestrator will be automatically re-invoked when ALL sub-issues are closed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "issues": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "List of all sub-issue numbers to launch agents on.",
                },
                "agent": {
                    "type": "string",
                    "description": "The agent name to dispatch on each sub-issue (e.g., 'engineer').",
                },
            },
            "required": ["issues", "agent"],
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

    if tool_name != "launch_sub_agent":
        send_error(request_id, -32601, f"Unknown tool: {tool_name}")
        return

    issues = arguments.get("issues", [])
    agent = arguments.get("agent")

    # Validate
    if not isinstance(issues, list) or len(issues) == 0:
        send_error(request_id, -32602, f"issues must be a non-empty list of integers, got: {issues}")
        return
    for i in issues:
        if not isinstance(i, int) or i <= 0:
            send_error(request_id, -32602, f"Each issue must be a positive integer, got: {i}")
            return
    if not isinstance(agent, str) or not agent:
        send_error(request_id, -32602, f"Invalid agent name: {agent}")
        return

    log(f"Launching agent '{agent}' on {len(issues)} sub-issues: {issues}")

    script = os.path.join(SCRIPT_DIR, "launch_sub_agent.sh")
    if not os.path.isfile(script):
        send_error(request_id, -32603, f"Script not found: {script}")
        return

    launched = []
    errors = []

    for issue in issues:
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
                errors.append(f"#{issue}: {result.stderr.strip() or 'unknown error'}")
            else:
                output = result.stdout.strip()
                log(f"Script output for #{issue}: {output}")
                launched.append(f"#{issue}")

        except subprocess.TimeoutExpired:
            errors.append(f"#{issue}: timed out after 30s")
        except OSError as e:
            errors.append(f"#{issue}: {e}")

    if errors and not launched:
        send_error(request_id, -32603, f"All launches failed: {'; '.join(errors)}")
        return

    summary_lines = [f"Agent '{agent}' launched on {len(launched)} sub-issue(s): {', '.join(launched)}."]
    if errors:
        summary_lines.append(f"Warning: {len(errors)} launch(es) failed: {'; '.join(errors)}")
    summary_lines.append("")
    summary_lines.append("The orchestrator session will now end.")
    summary_lines.append("It will resume automatically when all sub-issues are closed.")

    send_response(request_id, {
        "content": [
            {
                "type": "text",
                "text": "\n".join(summary_lines),
            }
        ],
        "isError": False,
        "session_ends": True,
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

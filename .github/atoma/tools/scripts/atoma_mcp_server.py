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
            "Launch an Atoma agent on a sub-issue and suspend the orchestrator session. "
            "Use this after creating sub-issues via GitHub MCP. "
            "Call this once for each sub-issue you want to dispatch an agent to. "
            "After calling this for all sub-issues, the orchestrator session will end. "
            "The orchestrator will be automatically re-invoked when all sub-issues are closed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "issue": {
                    "type": "integer",
                    "description": "The sub-issue number to launch the agent on.",
                },
                "agent": {
                    "type": "string",
                    "description": "The agent name to dispatch (e.g., 'engineer').",
                },
            },
            "required": ["issue", "agent"],
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

    issue = arguments.get("issue")
    agent = arguments.get("agent")

    # Validate
    if not isinstance(issue, int) or issue <= 0:
        send_error(request_id, -32602, f"Invalid issue number: {issue}")
        return
    if not isinstance(agent, str) or not agent:
        send_error(request_id, -32602, f"Invalid agent name: {agent}")
        return

    log(f"Launching agent '{agent}' on sub-issue #{issue}")

    script = os.path.join(SCRIPT_DIR, "launch_sub_agent.sh")
    if not os.path.isfile(script):
        send_error(request_id, -32603, f"Script not found: {script}")
        return

    try:
        result = subprocess.run(
            ["bash", script, "--issue", str(issue), "--agent", agent],
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "ISSUE_NUMBER": str(issue)},
        )

        if result.returncode != 0:
            log(f"Script failed (exit {result.returncode}): {result.stderr}")
            send_error(
                request_id,
                -32603,
                f"launch_sub_agent failed: {result.stderr.strip() or 'unknown error'}",
            )
            return

        output = result.stdout.strip()
        log(f"Script output: {output}")

        send_response(request_id, {
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"Agent '{agent}' launched on sub-issue #{issue}.\n"
                        f"{output}\n\n"
                        "The orchestrator session will now end. "
                        "It will resume automatically when all sub-issues are closed."
                    ),
                }
            ],
            "isError": False,
            "session_ends": True,
        })

    except subprocess.TimeoutExpired:
        send_error(request_id, -32603, "launch_sub_agent timed out after 30s")
    except OSError as e:
        send_error(request_id, -32603, f"Failed to execute launch_sub_agent.sh: {e}")


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

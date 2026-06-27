#!/usr/bin/env bash
set -euo pipefail

# launch_sub_agent.sh
# MCP tool for the orchestrator to launch an agent on a sub-issue.
# When this tool returns, the orchestrator session should end.
# The orchestrator will be re-invoked automatically when all sub-issues close.

ISSUE=""
AGENT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue)
            ISSUE="$2"
            shift 2
            ;;
        --agent)
            AGENT="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: launch_sub_agent --issue N --agent AGENT_NAME"
            echo ""
            echo "Launch an Atoma agent on a sub-issue and signal session suspension."
            echo "The orchestrator session will end after all sub-agents are launched."
            echo "It will resume automatically when all sub-issues complete."
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$ISSUE" ]]; then
    echo "Error: --issue is required" >&2
    exit 1
fi

if [[ -z "$AGENT" ]]; then
    echo "Error: --agent is required" >&2
    exit 1
fi

if ! [[ "$ISSUE" =~ ^[0-9]+$ ]]; then
    echo "Error: --issue must be a positive integer, got: ${ISSUE}" >&2
    exit 1
fi

if ! [[ "$AGENT" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo "Error: --agent must be a valid lowercase agent name, got: ${AGENT}" >&2
    exit 1
fi

echo "Launching agent '${AGENT}' on sub-issue #${ISSUE} ..." >&2

# Post a comment announcing the agent dispatch
gh issue comment "${ISSUE}" \
  --body "<!-- atoma:agent-launched -->
**Atoma:** Agent \`${AGENT}\` has been dispatched to work on this sub-task.

The orchestrator session has been suspended. It will resume automatically when all sub-issues are complete."

# Transition from pending to active: remove pending label
gh issue edit "${ISSUE}" --remove-label "atoma/pending" 2>/dev/null || true

# Dispatch the atoma-runner workflow for this agent on this issue
DISPATCH_WORKFLOW="${ATOMA_DISPATCH_WORKFLOW:-atoma-runner.yml}"

echo "Dispatching workflow '${DISPATCH_WORKFLOW}' for agent=${AGENT} issue=#${ISSUE} ..." >&2

gh workflow run "$DISPATCH_WORKFLOW" \
    --field agent="$AGENT" \
    --field number="$ISSUE" \
    --field type="issue" \
    --field notify=""

echo "launched: agent=${AGENT} issue=#${ISSUE}"

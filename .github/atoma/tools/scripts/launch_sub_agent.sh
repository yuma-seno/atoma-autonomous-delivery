#!/usr/bin/env bash
set -euo pipefail

# launch_sub_agent.sh
# Backend for the atoma__launch_sub_agent MCP tool.
# Posts a dispatch comment on each sub-issue. The atoma-dispatch workflow
# detects these comments and dispatches the appropriate agent.

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
            echo "Post a dispatch comment on a sub-issue. The atoma-dispatch"
            echo "workflow will detect the comment and launch the agent."
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

echo "Posting dispatch comment for agent '${AGENT}' on sub-issue #${ISSUE} ..." >&2

# Post a dispatch marker comment. atoma-dispatch.yml picks this up.
gh issue comment "${ISSUE}" \
  --body "<!-- atoma:dispatch=${AGENT} -->
**Atoma:** Agent \`${AGENT}\` will be dispatched to work on this sub-task.

The comment above triggers automatic agent dispatch."

echo "dispatched via comment: agent=${AGENT} issue=#${ISSUE}"

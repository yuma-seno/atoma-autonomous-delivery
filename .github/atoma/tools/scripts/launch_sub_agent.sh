#!/usr/bin/env bash
set -euo pipefail

# launch_sub_agent.sh
# Directly dispatches an Atoma agent on a sub-issue via gh workflow run.
# Called by atoma_mcp_server.py when the orchestrator uses atoma__launch_sub_agent.

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
            echo "Dispatch an agent on a sub-issue via direct workflow run."
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$ISSUE" ]]; then echo "Error: --issue is required" >&2; exit 1; fi
if [[ -z "$AGENT" ]]; then echo "Error: --agent is required" >&2; exit 1; fi
if ! [[ "$ISSUE" =~ ^[0-9]+$ ]]; then echo "Error: --issue must be a positive integer, got: ${ISSUE}" >&2; exit 1; fi
if ! [[ "$AGENT" =~ ^[a-z][a-z0-9-]*$ ]]; then echo "Error: --agent must be a valid lowercase agent name, got: ${AGENT}" >&2; exit 1; fi

echo "Dispatching agent '${AGENT}' on sub-issue #${ISSUE} ..." >&2

gh issue comment "${ISSUE}" \
  --body "Atoma: Agent \`${AGENT}\` dispatched to work on this sub-task."

# Mark this sub-issue as launched so aggregation gating (check_open_siblings.py)
# only waits on sub-issues that have actually been dispatched, not ones still
# pending a later phase (see docs/agent-definition.md dependency handling).
LAUNCHED_LABEL=$(python3 .github/atoma/tools/scripts/get_config_value.py "labels.launched" "atoma/launched")
gh issue edit "${ISSUE}" --add-label "${LAUNCHED_LABEL}" || echo "Warning: failed to add '${LAUNCHED_LABEL}' label to #${ISSUE}" >&2

DISPATCH_WORKFLOW="${ATOMA_DISPATCH_WORKFLOW:-atoma-runner.yml}"
gh workflow run "$DISPATCH_WORKFLOW" \
    --field agent="$AGENT" \
    --field number="$ISSUE" \
    --field type="issue" \
    --field notify="${ISSUE_NOTIFY:-}"

# Best-effort "eyes" reaction on the sub-issue itself so a human glancing at
# the tracker can tell at a glance that it's already being worked on, not
# just sitting idle waiting for attention (mirrors atoma-entry.yml's reaction
# on newly routed issues).
gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${ISSUE}/reactions" -f content="eyes" 2>/dev/null || true

echo "dispatched: agent=${AGENT} issue=#${ISSUE}"

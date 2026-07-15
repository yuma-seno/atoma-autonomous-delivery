#!/usr/bin/env bash
set -euo pipefail

# request_close_issue.sh
# Called by atoma_mcp_server.py when the orchestrator uses
# atoma__request_close_issue to conclude work on its CURRENT issue.
#
# Decides how to conclude based on who opened THIS issue -- a directly
# observable GitHub API fact, not something the LLM needs to recall about its
# own invocation history (a prompt-only version of this check was tried and
# failed live: the orchestrator once closed a root issue a human had opened
# directly, because it had to *remember* whether it was originally dispatched
# as a nested sub-issue orchestrator, which is not reliable):
#   - Bot-authored (a sub-issue created by another Atoma agent, e.g. via
#     github__create_issue or a nested orchestrator dispatch) -> close it
#     directly, then trigger the same phase-gating/aggregation dispatch used
#     by the normal merge_pr-driven close path.
#   - Human-authored (a root issue opened directly by a person) -> never
#     auto-close; instead post a comment mentioning them with the reason and
#     summary, asking them to review and close it themselves.

ISSUE=""
REASON=""
SUMMARY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --issue)
            ISSUE="$2"
            shift 2
            ;;
        --reason)
            REASON="$2"
            shift 2
            ;;
        --summary)
            SUMMARY="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: request_close_issue.sh --issue N --reason TEXT [--summary TEXT]"
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$ISSUE" ]]; then echo "Error: --issue is required" >&2; exit 1; fi
if [[ -z "$REASON" ]]; then echo "Error: --reason is required" >&2; exit 1; fi
if ! [[ "$ISSUE" =~ ^[0-9]+$ ]]; then echo "Error: --issue must be a positive integer, got: ${ISSUE}" >&2; exit 1; fi

REPO="${GITHUB_REPOSITORY}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# NOTE: `gh issue view --json author` returns {id, is_bot, login, name} -- there
# is NO `.type` field (that only exists on the REST `gh api .../issues/N`
# endpoint, as `.user.type`). Confirmed live: using `.author.type` here always
# silently evaluated to empty, so this ALWAYS fell through to the bot-authored
# (close) branch, even for a human-opened root issue -- use the reliable
# `.author.is_bot` boolean instead.
IS_BOT=$(gh issue view "${ISSUE}" --repo "${REPO}" --json author --jq '.author.is_bot // false')

BODY="Atoma: orchestrator considers work on this issue complete.

**Reason:** ${REASON}"
if [[ -n "$SUMMARY" ]]; then
  BODY="${BODY}

${SUMMARY}"
fi

if [[ "${IS_BOT}" != "true" ]]; then
  NOTIFY=$(python3 "${SCRIPT_DIR}/resolve_notify.py" --repo "${REPO}" --number "${ISSUE}" 2>/dev/null || true)
  MENTION=""
  [[ -n "$NOTIFY" ]] && MENTION="@${NOTIFY} "
  BODY="${MENTION}${BODY}

This issue was opened directly by a human, so it will not be closed automatically. Please review and close it yourself if you agree, or comment with further instructions."
  gh issue comment "${ISSUE}" --repo "${REPO}" --body "${BODY}"
  echo "escalated: issue=#${ISSUE} (human-authored, not closed)"
else
  gh issue comment "${ISSUE}" --repo "${REPO}" --body "${BODY}"
  gh issue close "${ISSUE}" --repo "${REPO}"
  echo "closed: issue=#${ISSUE} (bot-authored)"
  python3 "${SCRIPT_DIR}/dispatch_orchestrator_if_ready.py" --repo "${REPO}" --issue "${ISSUE}"
fi

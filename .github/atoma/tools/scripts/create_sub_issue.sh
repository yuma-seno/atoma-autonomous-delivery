#!/usr/bin/env bash
set -euo pipefail

# create_sub_issue.sh
# Creates a sub-issue linked to a parent issue.
# Does NOT trigger any agent — use launch_sub_agent.sh for that.

TITLE=""
BODY=""
PARENT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --title)
            TITLE="$2"
            shift 2
            ;;
        --body)
            BODY="$2"
            shift 2
            ;;
        --parent-issue)
            PARENT="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: create_sub_issue --title TITLE --body BODY --parent-issue N"
            echo ""
            echo "Creates a sub-issue with parent metadata. Does NOT trigger any agent."
            echo "Use launch_sub_agent.sh --issue N --agent NAME to dispatch agents."
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if [[ -z "$TITLE" ]]; then
    echo "Error: --title is required" >&2
    exit 1
fi

if [[ -z "$PARENT" ]]; then
    echo "Error: --parent-issue is required" >&2
    exit 1
fi

if ! [[ "$PARENT" =~ ^[0-9]+$ ]]; then
    echo "Error: --parent-issue must be a positive integer" >&2
    exit 1
fi

META="<!-- atoma:parent=#${PARENT} -->"
FULL_BODY="${META}

${BODY}"

BODY_FILE=$(mktemp)
printf '%s' "$FULL_BODY" > "$BODY_FILE"

echo "Creating sub-issue under parent #${PARENT} ..." >&2
ISSUE_URL=$(gh issue create --title "$TITLE" --body-file "$BODY_FILE")
rm -f "$BODY_FILE"

ISSUE_NUM=$(echo "$ISSUE_URL" | grep -oE '[0-9]+$')

echo "Sub-issue created: #${ISSUE_NUM} (${ISSUE_URL})" >&2

echo "$ISSUE_NUM"

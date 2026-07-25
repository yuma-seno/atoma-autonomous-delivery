---
name: delivery/implementation-handoff
description: Complete an implementation safely from local validation through commit, push, PR creation, and post-merge closure.
---

# Implementation Handoff

1. Read the issue, current branch state, and nearby implementation before editing.
2. Implement and validate the requested behavior, including focused regression coverage.
3. Review the final diff for unrelated changes, generated artifacts, and accidental omissions.
4. Run the repository's required focused and broad checks.
5. Commit and push all intended changes with `github__commit_and_push`.
6. Create the PR with `github__create_pr`; ensure the body explains behavior and verification. This tool ends the current session.
7. On post-merge re-entry, do not reopen implementation. Confirm the merged PR and close the sub-issue through the prescribed GitHub tool so parent aggregation can continue.

Never create a PR from uncommitted or unpushed work. Never continue issuing tools after a session-ending handoff call.

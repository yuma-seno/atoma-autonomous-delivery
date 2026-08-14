# Operations

This page explains how the generated workflows operate in production.

## Workflow entry points

Entry workflows:

- `atoma-entry.yml` for `issues.opened`
- `atoma-manual-comment.yml` for `issue_comment.created`
- `atoma-auto-trigger.yml` for `pull_request_target` opened/synchronize/ready_for_review
- `atoma-pr-review.yml` for `pull_request_review.submitted`
- `atoma-pr-merged.yml` for merged PR aggregation
- `atoma-sub-issue-closed.yml` for manual sub-issue close fallback

Shared executor:

- `atoma-runner.yml` is a reusable workflow called by routing workflows.

## Session persistence (`atoma-data` branch)

- Active sessions are stored by context and agent: `sessions/<type>-<number>/<agent>.json`.
- Recovery archives are stored beside the active sessions as `sessions/<type>-<number>/archive/<agent>-N.json`, where `N` is the next per-agent sequence number.
- Restore uses `git fetch` + `git show` from `origin/atoma-data` without checkout changes.
- Save uses an isolated git worktree and push-retry loop to handle concurrent writes safely.

## Manual commands and recovery

An agent command must occupy its own line. Put instructions on following lines:

```text
/engineer
Implement the remaining acceptance criteria.
```

Text after an agent name on the command line is rejected rather than guessed at,
because the name is used as a filename and as a shell word. A comment says so on
the issue; a new issue's body reports it as a warning on the workflow run and
starts nothing.

The only supported modifier is `recover`, and only in a comment — a new issue's
first line takes a bare name and nothing else:

```text
/engineer recover
Continue from the current Issue, repository, pull request, and CI state.
```

Recovery archives the previous agent session, does not restore its assistant/tool history, rebuilds a fresh session from current GitHub events, and then runs the named agent. Repository branches and GitHub state are not reset. Internal automation dispatches continue existing sessions by default.

## Serialization guard and in-progress label

- Runner uses workflow concurrency group per `<type>-<number>`.
- Runner adds `atoma/in-progress` label before agent execution.
- Manual comments during active runs are guarded:
  - comment can be deleted
  - commenter is notified to retry after completion
- Label release is decided by domain rule (`shouldReleaseGuard`), not by ad-hoc workflow condition strings.

## Dispatch, handoff, aggregation, idempotency

- Textual handoff is a standalone `/agent-name` line with the request on following lines; the name must have a definition in `agent-definitions/`, otherwise it is ignored and no dispatch happens.
- `extract_directive.ts` scans the whole output and adopts the first matching directive.
- Auto-dispatch loop counter is tracked in session metadata and capped at 5.
- PR merge path is the primary sub-issue aggregation trigger.
- Manual issue-close path is fallback and skips when closure already came from merged PR.
- Aggregation is idempotent via marker tags so racing paths do not dispatch orchestrator twice.

## Symptom-based troubleshooting

| Symptom | Likely cause | Recovery action |
| --- | --- | --- |
| Workflow ran but agent did not start | Route step produced empty `agent` output | Check issue first line slash command or trigger mapping in `config.json` |
| Agent exits immediately with provider error | Missing/invalid API credential or provider mismatch | Verify secrets and optional `ATOMA_PROVIDER` variable |
| `atoma/in-progress` label remains | Run chain still continuing or release step skipped by failure chain | Inspect `decide_guard_release` output and rerun after fixing upstream failure |
| Repeated handoffs stop automatically | Auto-dispatch loop limit reached (5) | Manually trigger next agent via comment command |
| Agent repeatedly reproduces stale or invalid tool behavior | Persisted conversation history is no longer useful | Run `/<agent> recover` on its own line, with any new instruction on following lines |
| Manual command reports invalid syntax | Instruction text was placed on the `/agent` line, or an unsupported modifier was used | Use a standalone `/<agent>` line, or `/<agent> recover`; put instructions below it |
| Parent orchestrator not re-invoked after sub-issue completion | Sibling sub-issues still open, or aggregation already handled by another path | Check sibling labels/tags and parent comments for aggregation marker |
| Comment disappeared during run | Guard deleted human comment while in-progress label active | Repost comment after current run ends |
| Draft pull request will not merge | PR is in draft and reviewer reports a `draft` blocker by design | Author marks the PR ready for review |
| Merge stays `BLOCKED` despite green check on head commit | `pull_request` run for the same commit awaits approval (`action_required`) | Approve the run in Actions or via `gh api --method POST repos/{owner}/{repo}/actions/runs/{run_id}/approve`; temporary workaround until #210 is fixed |

## Security boundaries

- Token boundary: workflows use `GITHUB_TOKEN` and declared write scopes to mutate issues/PRs/workflow dispatch.
- Shell guard boundary: command denylist for shell MCP calls; this is not a sandbox.
- Event boundary: `pull_request_target` executes in base repository context, so review trust model for external contributors before enabling broad automation.


# Operations

This page explains how the generated workflows operate in production.

## Workflow entry points

Entry workflows:

- `atoma-entry.yml` for `issues.opened`
- `atoma-manual-comment.yml` for `issue_comment.created`
- `atoma-pr-merged.yml` for merged PR aggregation
- `atoma-sub-issue-closed.yml` for manual sub-issue close fallback

`atoma-auto-trigger.yml` and `atoma-pr-review.yml` are gone (#486). They listened
for `pull_request_target` and `pull_request_review.submitted` to start a reviewer or
an engineer, and nothing now starts from a pull request event: work starts when a
person comments `/agent` or when an agent asks for the next one. See
[How work starts](customization.md#how-work-starts).

Dispatched, not event-driven:

- `atoma-validate-pr.yml` runs the configured CI against an agent's pull request,
  publishes the result as a check run, and dispatches whoever comes next.
  `create_pr` starts it. It cannot listen for the pull request itself, because
  GitHub starts no workflow run for events `GITHUB_TOKEN` triggers.

Shared executor:

- `atoma-runner.yml` is a reusable workflow called by routing workflows.

## Session persistence (`atoma-data` branch)

- Active sessions are stored by context and agent: `sessions/<type>-<number>/<agent>.json`.
- Recovery archives are stored beside the active sessions as `sessions/<type>-<number>/archive/<agent>-N.json`, where `N` is the next per-agent sequence number.
- Restore uses `git fetch` + `git show` from `origin/atoma-data` without checkout changes.
- Save uses an isolated git worktree and push-retry loop to handle concurrent writes safely.
- **A session is saved whatever ended the run**, including a failure. What this run
  worked out is still there; `/<agent> recover` archives it and starts fresh when that
  is what you want. The choice belongs to a person, not to the machinery.
- Each tool result is shortened to 4,000 characters on the way in, so a session does
  not grow past what a model will accept. Nine results in ten are under that already.
- If a restored session is still too big, the contents of older tool results are
  replaced with a note. **The calls themselves stay**, so an agent can see what it
  already looked at and re-fetch only what it still needs. Nothing is removed, so a
  tool call can never be left without its result.

## Work branches (`atoma/issue-N`)

- A branch is created at the first commit, not at the start of a run. A run that
  only reports, confirms a merge, or closes an issue leaves no branch behind.
- The name is `atoma/issue-N`. A merge deletes the branch, so the same issue's
  next piece of work takes that name again, cut fresh from the base branch.
- If a merged branch is still there — a deletion that failed, or a merge made
  some other way — the next name counts up instead: `atoma/issue-N-2`, then
  `atoma/issue-N-3`. Work never resumes on merged history.
- When an unmerged branch is left behind, the issue's next run resumes it
  instead of starting from the base branch.
- A sub-issue's branch is cut from its parent's and merges back into it, so
  sibling tasks see each other's work as it lands. The parent's branch is created
  empty when the first child commits, and reaches the base branch as one pull
  request once every child is done. Deployment is not dispatched for a merge into
  a parent branch — that work is still in progress.

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

### Stopping a run, and continuing it

`/stop` on its own line stops the agent currently running on that issue or pull
request. `/resume` continues it.

```text
/stop
```

Three things are worth knowing about it.

**It is not immediate.** The running job polls for the request every 30 seconds, and
the agent stops at its next turn — so it can finish the tool call it is in and start
one more. Expect up to a minute or two. The comment Atoma posts in reply says this,
because a command that appears to do nothing looks broken.

**Nothing is lost.** The agent stops between turns, where the conversation is
complete, and writes its session before exiting. This is the whole reason `/stop`
exists rather than a note saying "cancel the workflow run": a cancelled job never
reaches the step that saves the session, so cancelling means discarding.

**Your `/stop` comment is deleted.** It must not become part of what the agent reads
when it resumes — a paused run is not a run that was told something. Atoma's reply
carries the record of who asked and when, and is itself excluded from the agent's
context.

A stopped run has ended and handed back to a person, which is the same terminal
state as an agent that finished its turn or ran out of time. So the `atoma/in-progress`
label comes off, nothing is dispatched next, and the issue is open for comment again.
There is no separate "paused" state to get stuck in.

To continue:

| | |
| --- | --- |
| `/resume` | continue with the same agent and the saved session, carrying no new instruction |
| `/<agent>` + instructions on the following lines | continue with an instruction of your own, which is what to use when you stopped the run because it was going the wrong way |

`/resume` finds the agent from the last one that ran here, so there is nothing to
remember. It takes no instruction of its own — the ordinary agent command already
does that, and having two ways to say it would only make one of them wrong.

**On a parent issue.** An orchestrator keeps the in-progress label while its chain
runs on sub-issues, so a `/stop` on the parent may be aimed at a number where nothing
is executing. It still posts the request, and it also lists the sub-issues that are
running so you can stop those. It does not stop them for you: their sessions are
separate, and stopping work nobody asked to stop is the worse mistake.

## Serialization guard and in-progress label

- Runner uses workflow concurrency group per `<type>-<number>`.
- Runner adds `atoma/in-progress` label before agent execution.
- Manual comments during active runs are guarded:
  - comment can be deleted
  - commenter is notified to retry after completion
  - `/stop` is the one exemption: it is the only command whose meaning is "act on the
    run happening right now", so guarding it would make it unusable exactly when it
    is needed
- Label release is decided by domain rule (`shouldReleaseGuard`), not by ad-hoc workflow condition strings.

## Dispatch, handoff, aggregation, idempotency

- Textual handoff is a standalone `/agent-name` line with the request on following lines; the name must have a definition in `agent-definitions/`, otherwise it is ignored and no dispatch happens.
- `extract_directive.ts` scans the whole output and adopts the first matching directive.
- Agent handoffs are counted from the target's own comments, not stored, and capped at `limits.agent_handoffs` (default 5). See `domain/dispatch-chain.ts`.
- `create_pr` dispatches `atoma-validate-pr.yml`, which runs the configured CI on the branch, writes the result as a check run, then dispatches the agent the result calls for — the reviewer NAMED IN THE CALL on green, the engineer on failure. No reviewer named means CI runs and nothing follows; `create_pr` then leaves a notice on the pull request saying nobody is scheduled.
- PR merge path is the primary sub-issue aggregation trigger.
- Manual issue-close path is fallback and skips when closure already came from merged PR.
- Aggregation is idempotent via marker tags so racing paths do not dispatch orchestrator twice.

## Symptom-based troubleshooting

| Symptom | Likely cause | Recovery action |
| --- | --- | --- |
| Workflow ran but agent did not start | Route step produced empty `agent` output | Check issue first line slash command or trigger mapping in `config.json` |
| Agent exits immediately with provider error | Missing/invalid API credential or provider mismatch | Verify secrets and optional `ATOMA_PROVIDER` variable |
| `More than one provider credential is set` | Two provider secrets exist, so the credentials do not decide which to use | Remove the one this repository does not use, or name the provider in `ATOMA_PROVIDER` |
| `atoma/in-progress` label remains | Run chain still continuing or release step skipped by failure chain | Inspect `decide_guard_release` output and rerun after fixing upstream failure |
| Repeated handoffs stop automatically | Auto-dispatch loop limit reached (5) | Manually trigger next agent via comment command |
| Agent repeatedly reproduces stale or invalid tool behavior | Persisted conversation history is no longer useful | Run `/<agent> recover` on its own line, with any new instruction on following lines |
| Manual command reports invalid syntax | Instruction text was placed on the `/agent` line, or an unsupported modifier was used | Use a standalone `/<agent>` line, or `/<agent> recover`; put instructions below it |
| Parent orchestrator not re-invoked after sub-issue completion | Sibling sub-issues still open, or aggregation already handled by another path | Check sibling labels/tags and parent comments for aggregation marker |
| Comment disappeared during run | Guard deleted human comment while in-progress label active | Repost comment after current run ends |
| Draft pull request will not merge | PR is in draft and reviewer reports a `draft` blocker by design | Author marks the PR ready for review |
| Agent's pull request shows a check stuck at `action_required` | GitHub holds `pull_request` runs for pull requests opened with `GITHUB_TOKEN` | Expected; the merge does not depend on it. Approve it to clear the display, but never delete the run — that breaks the commit's check rollup permanently |
| Required check never fills on an agent's pull request | The workflow behind that context has no `workflow_dispatch` trigger, so Atoma cannot run it | Add `workflow_dispatch` to it, or drop the context from the ruleset's required list |
| Agent run takes longer than expected or consumes excessive tokens | High number of shell tool round trips, or large tool output size | Read the `[atoma-shell]` lines in the workflow log; each records the command, exit code, duration, and output byte size |

## Security boundaries

- Token boundary: workflows use `GITHUB_TOKEN` and declared write scopes to mutate issues/PRs/workflow dispatch.
- Shell guard: **not** a boundary. It redirects the agent to the MCP tool that does the job properly, and is a text match over a command line rather than a sandbox. Per-tool credential confinement and the governed-paths merge gate are the controls.
- Event boundary: `pull_request_target` executes in base repository context, so review trust model for external contributors before enabling broad automation.

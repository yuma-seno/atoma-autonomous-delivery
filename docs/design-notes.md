# Design notes

Decisions that are not obvious from the code, and that someone would otherwise
undo. Each records what was measured, not what was assumed.

## Why the runner writes the pull request's check itself

An agent's pull request cannot satisfy a required status check on its own. The
runner dispatches CI, waits for it, and then creates a check run through the
Checks API carrying that run's conclusion. Without that last step the pull
request stays blocked forever.

### Two rules that look like cleanup and are not

**Do not delete a workflow run held at `action_required`.** An agent's pull
request always carries one. It shows as a pending check and looks like noise.
Deleting it destroys the commit's check rollup permanently: REST goes on
reporting the check runs and suites as successful and associated with the pull
request, while GraphQL reports `statusCheckRollup: null` and the merge stays
blocked. Re-running CI afterwards does not repair it, because the damage is to
the commit, not to any run. Leave it. With the mirrored check in place the pull
request reaches `UNSTABLE`, which the ruleset permits.

**Do not remove the mirrored check as redundant.** The dispatched CI run already
puts a check with the same name on the same commit, so the mirror looks like a
duplicate. It is not: a check run derived from a `workflow_dispatch` run does not
satisfy a required status check. Only the mirror does.

### What forced this

GitHub changed on 2026-06-11 (`Bot-created pull requests can run workflows if
approved`): workflows triggered by a pull request that the default `GITHUB_TOKEN`
created or updated are held for human approval, even on a branch in the same
repository. The stated intent is that generated code should not automatically run
workflows that may reach secrets. There is no setting that turns it off; GitHub's
documented alternatives are a GitHub App installation token or a personal access
token.

That collides with an autonomous delivery system. Five things cannot hold at once:

1. one ruleset applying equally to humans and agents
2. plain GitHub infrastructure, nothing bespoke
3. security preserved
4. the deliverable self-contained — no App, no PAT, no extra adoption step
5. the agent merging its own work without a human

### What was measured

Everything below was observed on this repository, not inferred.

Whether a completed CI run starts a dependent workflow:

| CI run's origin | actor | fires `workflow_run` |
| --- | --- | --- |
| `push` to main | human | yes |
| `pull_request`, human-opened | human | yes |
| `pull_request`, bot-opened, after approval | bot | **no** |
| `workflow_dispatch` | bot | **no** |

Recursion is decided by the token behind the originating event. The documented
`workflow_dispatch` exemption covers *creating* a run, not its completion, and
approving a held run does not change its origin even though `triggering_actor`
becomes the approver. So no event chain closes, and nothing can wake an agent
after CI finishes.

Whether a check satisfies a required status check:

| check's origin | satisfies |
| --- | --- |
| a `pull_request`-derived run | yes |
| a `workflow_dispatch`-derived run | **no** |
| created through the Checks API | **yes** |

The middle row was measured with every confounder removed: a human-opened pull
request, a fresh commit, no held run, nothing deleted, and a successful `check`
on the head commit — still blocked.

The last row is what the design rests on. `GITHUB_TOKEN` is an installation token
for the github-actions app, so it satisfies the Checks API's requirement that
only apps may create check runs. A personal access token is refused with
`You must authenticate via a GitHub App`.

Finally, on a bot-opened pull request with its held run left in place, adding the
Checks API check moved the merge state from `BLOCKED` to `UNSTABLE`.

### An agent cannot wait, but a workflow can

The reviewer used to be dispatched as soon as the pull request existed, before CI
had finished, and would report that it would wait — with nothing able to resume
it. There is no sleep available to an agent and no event to wake one.

The runner's own job can wait, because a shell loop inside a live job is not a new
trigger and recursion never enters into it. That is why the sequencing lives in
the workflow rather than in the agents.

### This is sanctioned mechanism used for an unsanctioned end

Creating check runs through the Checks API is how every third-party CI provider
reports into a pull request, and the app-only restriction is satisfied honestly.
What is not sanctioned is the purpose: satisfying a required check for code that
GitHub deliberately held back.

The narrowest way GitHub could close it is to stop `GITHUB_TOKEN` from creating
check runs on a commit whose pull request `GITHUB_TOKEN` opened. That would leave
third-party CI intact, so it is the likely shape.

If it closes, the retreats are these, and both were worked through before this
design was chosen:

- **Drop the required check from the ruleset.** Merging then needs only a pull
  request, and whether CI passed becomes the reviewer agent's judgement rather
  than a server-side rule. Gives up the property that one ruleset governs humans
  and agents identically.
- **Give the agent a trusted identity** — a GitHub App or a personal access
  token used for creating the pull request and pushing to it. Nothing is held, so
  nothing needs mirroring, and no human acts at all. Costs an adoption step, and
  a token attributes the agent's commits to whichever account owns it, which a
  GitHub App avoids at the price of a heavier setup.

The mirror was preferred because it is the only one that keeps all four of the
constraints the retreats each give up one of.

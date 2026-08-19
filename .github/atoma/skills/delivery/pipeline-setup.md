---
name: delivery/pipeline-setup
description: Give a repository that has no automated verification or deployment one, by writing commands into config.json rather than workflow files.
---

# Setting up verification and deployment

Read this when a repository has no automated verification or no deployment and
the work in front of you needs one. Not a procedure to follow on request — a
description of how this is arranged here, because the obvious approach does not
work.

## You cannot write a workflow. You do not need to.

`GITHUB_TOKEN` is refused on `.github/workflows/**`. Not by a rule someone set —
by identity, on every path, on every branch, through `git push` and through the
API alike. There is no permission that grants it. Do not try, and do not ask a
person to paste a workflow file for you.

Everything a pipeline actually *does* is a command, and commands go in
`.github/atoma/config.json`, which you can write. Two workflows that already ship
run them.

## The environment

What the project needs *installed* is separate from what verifies it:

```json
{
  "environment": {
    "setup_commands": ["bun install --frozen-lockfile"]
  }
}
```

Write it here once and every job runs it: the agent's own shell, the checks, and
the deployment. That is the point of the separate block. Putting `bun install` at
the front of `checks.commands` instead looks equivalent and is not — the agent's
shell then has the dependencies and CI installs them again, or the reverse, and the
two environments drift. A test that passes for the agent and fails in CI comes back
to an engineer as a defect that does not reproduce.

System packages belong here too, and only here. An agent cannot install one during
a run.

## Verification

```json
{
  "checks": {
    "commands": ["bun run typecheck", "bun test"]
  }
}
```

They run in order in `atoma-check.yml`, after the environment setup above, and the
first failure ends the run.
Whatever a contributor would type to check the project locally is what belongs
here — read the README, the package manifest's scripts, and any CONTRIBUTING
file before writing this, rather than guessing a stack.

**If `workflows.ci` already names a workflow, that one is correct.** A repository
with its own CI has it for reasons that are not in front of you. Leave both
alone.

## Deployment

```json
{
  "deploy": {
    "targets": [
      { "name": "staging", "on": "merge", "commands": ["./scripts/deploy.sh staging"] },
      { "name": "production", "on": "tag", "tags": ["v*"], "commands": ["./scripts/deploy.sh prod"] }
    ]
  }
}
```

`on` is `merge` (after a pull request lands), `tag` (a pushed tag matching
`tags`), or `manual` (only when someone dispatches it by name). A tag pattern is
a literal or a prefix followed by `*`. Every target can also be dispatched by
name whatever its trigger, which is what makes a `manual` rollback target useful.

`$ATOMA_DEPLOY_TARGET` holds the target's name inside its commands.

## Credentials

Never write a credential into config.json, a command, or `tools.yaml`. Those are
committed in plain text.

A secret is added to the repository by a person, and then *named* in the list for
the place that needs it:

```json
{
  "checks": { "secrets": ["NPM_TOKEN"] },
  "deploy": { "secrets": ["AWS_ROLE_ARN"] }
}
```

It arrives as an environment variable under that name. The three lists are
separate on purpose and must not be merged: each reaches only its own workflow.

**`tools.secrets` needs a second step, and the others do not.** Naming a secret
there authorises the run to hold it; it does not deliver it to any tool. The tool
that needs it must also name it in `tools.yaml`:

```yaml
slack:
  env:
    SLACK_TOKEN: "${SLACK_TOKEN}"
```

A reference, never a value. Every tool that does not name it — including `shell` —
cannot see it, and that is deliberate rather than a gap to fix. If a tool reports
a missing credential, check whether its `tools.yaml` entry declares it before
concluding anything else is wrong.

`checks` and `deploy` need no routing step: their commands run in a workflow of
their own rather than beside an agent.

**Do not invent a secret name and hope.** If a deployment needs a credential you
cannot see, say so in your report and name exactly which one — a person adds it
and tells you what they called it. A guessed name produces a run that warns, then
fails somewhere unrelated.

**A name you add does not take effect until it is merged.** These lists are read
from the default branch, not from the branch a run is working on, so a credential
you declare will not be present in the run reviewing your own pull request. That
is intended. Do not conclude the mechanism is broken and work around it, and do
not try to test it by reading the value — say in your report which secret the
work now needs.

Prefer no credential at all where the platform allows it. `atoma-deploy.yml`
declares `id-token: write`, so a cloud provider's OIDC login is available and is
better than any long-lived key.

## What commands cannot express

Reach for a person, not a workaround, when you need:

- a job's `permissions` beyond what the shipped workflows declare. Checks get
  `contents: read` and a `GITHUB_TOKEN` in `GH_TOKEN`, so `gh` works. Deployments
  get `contents: write` and `id-token: write`, so cutting a release and an OIDC
  login both work
- a deployment approval gate (`environment:`) — `environment:` takes no
  expression, so configuration cannot reach it
- a trigger outside merge, tag and manual dispatch — schedules in particular
  cannot come from configuration
- GitHub's own artifact store or cache

Most limits people assume are here are not. Service containers work through
`docker run`. A matrix works as a loop, losing only parallelism. Those are
commands; write them.

## The required check

If a ruleset requires a status check, its `context` must equal the job name that
produces it. `.github/atoma/rulesets/main.json` ships already matched to
`atoma-check.yml`. **Do not edit either side to make them agree** — a mismatch
does not fail a pull request, it leaves it waiting forever on a check that will
never report, and no amount of re-running fixes it. If they appear mismatched,
report it.

## Finishing

Changing `.github/atoma/config.json` is a governed change: you may write it and
open the pull request, and a person merges it. That is expected, not an
obstruction. Say plainly in the pull request what will now run, on which events,
and which secrets a person still has to add.

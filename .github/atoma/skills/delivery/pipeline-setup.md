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

## Verification

```json
{
  "checks": {
    "commands": ["bun install --frozen-lockfile", "bun run typecheck", "bun test"]
  }
}
```

They run in order in `atoma-check.yml`, and the first failure ends the run.
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
separate on purpose and must not be merged: `tools.secrets` reaches your own
process, `checks.secrets` and `deploy.secrets` reach only their workflows.

**Do not invent a secret name and hope.** If a deployment needs a credential you
cannot see, say so in your report and name exactly which one — a person adds it
and tells you what they called it. A guessed name produces a run that warns, then
fails somewhere unrelated.

Prefer no credential at all where the platform allows it. `atoma-deploy.yml`
declares `id-token: write`, so a cloud provider's OIDC login is available and is
better than any long-lived key.

## What commands cannot express

Reach for a person, not a workaround, when you need:

- a job's `permissions` beyond what the shipped workflows declare
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

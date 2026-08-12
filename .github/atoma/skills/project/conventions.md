---
name: project/conventions
description: Conventions specific to THIS repository, which override the generic defaults. Load before making, reviewing, or committing any change here.
---

# Repository conventions

This repository builds the Atoma delivery template. It is both the producer of
that template and an adopter of it, which creates rules that do not apply
anywhere else.

This file is not part of the template. It lives under `.github/atoma/skills/project/`,
which the deploy job preserves, and it is deliberately absent from `src/` so
adopters never receive it.

## The three trees

| Tree | What it is | Who writes it |
| --- | --- | --- |
| `src/**` | Source | You |
| `dist/.github/**` | The deliverable adopters copy | The build |
| `.github/**` | This repo's own running configuration | The deploy job, from `dist/` |

`src/atoma/**` is mirrored verbatim into `dist/.github/atoma/` and from there
into an adopter's repository. **It may only contain content that holds for any
project using Atoma.** No reference to this repository's build pipeline, no
mention of `dist/`, `bun run synth`, or `build-dist.ts`, and no incident history
or PR numbers. If a rule is about developing *this* repository, it belongs in
this file instead.

## Generated output is not tracked

Change `src/**` only. `dist/**` is gitignored, so there is nothing generated to
commit and nothing to keep in sync.

Run `bun run synth` freely to inspect what adopters would receive. It writes only
into the ignored `dist/`, so it cannot dirty your commit.

Adopters receive the deliverable from a release, not from a merge, so nothing you
merge needs to carry it.

`.github/**` is a different matter — see below. It is tracked and not regenerated,
so a change there is yours to make and review.

## main is protected; everything lands by pull request

`.github/rulesets/main.json` is the source of truth for what may reach main:
direct pushes are refused, and a pull request cannot merge until the `check` job
passes. It is applied by hand from an account with admin, and taken as correctly
configured thereafter — nothing verifies it, because a check could only report and
never enforce: with no ruleset, `check` would not be a required context either.

Changing the rule is a pull request against the JSON, followed by one `gh api`
call from an account with admin (see CONTRIBUTING.md). CI cannot make that call —
`administration` is not a permission a workflow can hold.

`github__check_merge_readiness` reports against whatever the ruleset currently
requires, so it follows the file rather than holding a second opinion.

Nothing bypasses it. No workflow writes to main — `cd.yml` attaches the deliverable
to a release instead — and your merge satisfies the rules like anyone else's. Do
not propose a bypass actor: it would mean naming a GitHub App ID or a deploy key,
values that exist only after manual setup, so the JSON would stop describing the
whole configuration.

`ci.yml` and `cd.yml` are hand-written and live only under
`.github/workflows/`. They survive the upgrade copy because `dist/.github/` does
not contain them.

## Adding a static file to the deliverable

A new non-code file under `src/atoma/` must also be added to `build-dist.ts`'s
verbatim-copy list, or it never reaches `dist/` at all.
`tests/contract/deployment-contract.test.ts` enforces this.

## `.github/` is an adoption, not a mirror

Nothing regenerates `.github/` automatically. It is this repository's deliberate
adoption of the deliverable, so it lags `src/` until someone upgrades it:

```bash
bun run synth && cp -r dist/.github/. .github/ && git checkout -- .github/atoma/config.json
git diff .github/
```

This one-liner is correct **for this repository specifically**, because this
repository is the template's author: its agent definitions, skills and prompt
template are the deliverable, so there is nothing of its own to lose in them.
`config.json` is the single exception, carrying `workflows.cd` — without which
nothing publishes `dist/` after an agent merge.

Do not read it as the general procedure. An adopter who has tuned an agent
definition would lose that, which is why `docs/customization.md` documents
upgrading as a git-mediated merge rather than a copy. Read the diff either way.

Then open a pull request with the result. That lag is the point — a change to
`src/` must not reconfigure the live agents the moment it merges. Two breakages
reached the running system exactly that way.

`cp -r <source>/. <dest>/` writes what the deliverable contains and touches
nothing else, so `workflows/ci.yml` and this directory survive with no preserve
list needed: neither exists in `dist/.github/`.

What it will not do is remove a file the template has *deleted*. That leaves no
diff, so it is invisible in review — when the upgrade follows a change that
removed something, look for orphans under `.github/atoma/` yourself.

A human has to run it. GitHub refuses to let an App write files under
`.github/workflows/`, and the upgrade copy overwrites
`.github/workflows/atoma-*.yml`, so no automation can perform this step.

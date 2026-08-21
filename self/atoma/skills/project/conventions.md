---
name: project/conventions
description: Conventions specific to THIS repository, which override the generic defaults. Load before making, reviewing, or committing any change here.
---

# Repository conventions

This repository builds the Atoma delivery template. It is both the producer of
that template and an adopter of it, which creates rules that do not apply
anywhere else.

This file is not part of the template. Its source is `self/atoma/skills/project/`,
and it is deliberately absent from `src/` so adopters never receive it.

## The four trees

| Tree | What it is | Who writes it |
| --- | --- | --- |
| `src/**` | Source of the deliverable | You |
| `dist/.github/**` | The deliverable adopters receive | The build |
| `self/**` | This repository's own four files | You |
| `.github/**` | This repository's running configuration | The self-deploy job, from a release plus `self/` |

Two different activities live in this table, and which one you are doing decides
which rules apply:

- **improving the deliverable** — `src/**`. It affects every adopter, and it
  reaches this repository only after a release and a self-deploy.
- **improving this repository's own operation** — `self/**`. It affects nobody
  else, and it applies as soon as it merges.

The rest of this file does not separate them cleanly. That is a known gap, tracked
in #323; until then, read each rule and ask which of the two it is about.

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

**Do not touch `version` in `package.json` unless releasing is the task.** The release job
derives the release tag from it, so bumping it is what publishes to adopters —
merging that change cuts a release rather than merely recording an intent to. A
version left alone is a merge that publishes nothing, which is the normal case.

`.github/**` is a different matter — see below. It is tracked, and every file in it
comes from either the release or `self/`.

## main is protected; everything lands by pull request

`.github/atoma/rulesets/main.json` is the source of truth for what may reach main:
direct pushes are refused, and a pull request cannot merge until the `check` job
passes. It is applied by hand from an account with admin, and taken as correctly
configured thereafter — nothing verifies it, because a check could only report and
never enforce: with no ruleset, `check` would not be a required context either.

Changing the rule is a pull request against the JSON, followed by one `gh api`
call from an account with admin (see CONTRIBUTING.md). CI cannot make that call —
`administration` is not a permission a workflow can hold.

`github__check_merge_readiness` reports against whatever the ruleset currently
requires, so it follows the file rather than holding a second opinion.

Nothing bypasses it. No workflow writes to main — the release job attaches the deliverable
to a release instead — and your merge satisfies the rules like anyone else's. Do
not propose a bypass actor: it would mean naming a GitHub App ID or a deploy key,
values that exist only after manual setup, so the JSON would stop describing the
whole configuration.

The workflows that run agents are generated from `src/workflows/` and shipped.
`self/workflows/` holds the two that are not: `atoma-self-deploy.yml` and
`probe-dumpable.yml`.

## Adding a static file to the deliverable

A new non-code file under `src/atoma/` must also be added to `build-dist.ts`'s
verbatim-copy list, or it never reaches `dist/` at all.
`tests/contract/deployment-contract.test.ts` enforces this.

## `.github/` is an adoption, not a mirror

Nothing regenerates `.github/` automatically. It is this repository's deliberate
adoption of the deliverable, so it lags `src/` until someone applies a release.

**That lag is the point.** A change to `src/` must not reconfigure the live agents
the moment it merges. Two breakages reached the running system exactly that way.

### Applying a release

Dispatch **Atoma Self Deploy** (`self/workflows/atoma-self-deploy.yml`) from the
Actions tab. It opens a pull request and merges nothing. `.github/**` is in
`governed_paths`, so a person reviews it.

What it does:

```bash
rm -rf .github            # so a file the release DELETED is gone, not orphaned
unzip release.zip         # the deliverable
cp -r self/. .github/     # this repository's own, at the same paths
```

`.github/` is therefore exactly those two sources, with nothing kept alive by
remembering to. Before `self/` existed this was a `cp -r` followed by
`git checkout -- .github/atoma/config.json`, and a file the template had removed
stayed in the tree with no diff to notice it by.

It needs `ATOMA_SELF_DEPLOY_TOKEN`, a PAT with the `workflow` scope, because
`GITHUB_TOKEN` cannot write `.github/workflows/**` — refused on identity, not by
path. No agent can reach that token: it is named in one file outside the
deliverable, and `atoma-runner.yml` does not mention it.

### Changing something in `self/`

An overlay entry is a copy, not a build, so it needs no release. Change
`self/X` and `.github/X` **in the same pull request**, identically.

`tests/contract/self-overlay.test.ts` requires them byte-identical, in both
directions. Editing `.github/X` alone is worse than not editing it at all: the next
self-deploy overwrites it from `self/` and the change disappears without a diff.

A file added to `.github/` that is in no release and not in `self/` is not checked
for, because the next deploy removes it anyway and because `.github/**` is in
`governed_paths` — no agent can merge a change there, so a person reads it first.


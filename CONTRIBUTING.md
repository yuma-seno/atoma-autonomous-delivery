# Contributing

## Source-of-truth map

Everything here divides into two kinds: **the deliverable**, which adopters
receive, and **this repository's own tooling**, which they must never see.

The deliverable:

- `src/`: hand-authored source for the template — agent definitions, skills, MCP
  servers, workflow definitions. Adopter-agnostic by rule: no reference to this
  repository's build pipeline, no incident history, no PR numbers.
- `dist/.github/`: generated from `src/` by `bun run synth`. This is what adopters
  receive. **Not tracked in git** — it is a pure function of `src/`, and the
  release deployment publishes it as a release asset rather than committing it.
- `scripts/`: this project's own pipeline. `scan-secrets.sh` and `release.sh` are
  what `checks.commands` and `deploy.targets` name, and they are the reason there
  are no hand-written workflows left. Governed, like `.github/`.

This repository's own:

- top-level `.github/`: this repository's adoption of the deliverable, and nothing
  else — every workflow here is generated. Upgraded deliberately, not on merge:
  `bun run synth && cp -r dist/.github/. .github/ && git checkout -- .github/atoma/config.json`,
  then read `git diff .github/` and open a pull request. Restoring `config.json`
  encodes the rule that generated files are overwritten and configuration is not.
  This shortcut holds only because this repository authors the template, so its
  agent definitions and skills have nothing of their own to lose; adopters upgrade
  as a merge instead — see [docs/customization.md](docs/customization.md).
  Project-specific agent rules live in `.github/atoma/skills/project/`.
- `tests/`: tests of the build-and-deploy machinery. Tests of *shipped behaviour*
  live beside the shipped code instead.
- `docs/`: adopter-facing documentation.

Nothing this repository needs for itself belongs under `src/`. That includes
tests of the pipeline, operational scripts, and any rule phrased in terms of
`dist/`, `synth`, or this repository's CI — adopters have none of those.

When changing template behavior, treat `src/` as canonical.

## Branch protection

What may reach `main` is declared in `.github/rulesets/main.json`: no direct
pushes, no force-pushes, no branch deletion, and a pull request that cannot merge
until the `atoma-check` job passes.

That context is the job name in `atoma-check.yml`, and the two are joined by
nothing but the string. `generated-workflows.test.ts` holds the shipped pair
together; this repository's copy of the ruleset is applied by hand, so renaming
either side means applying it again:

```bash
gh api -X PUT repos/{owner}/{repo}/rulesets/{id} --input .github/rulesets/main.json
```

A required context no job produces does not fail a pull request — it leaves it
waiting forever on a check that will never report.

**Nothing needs a bypass.** No workflow writes to `main` — the release deployment
attaches the deliverable to a release instead, which is why `dist/` is no longer
tracked. An
agent merging a pull request needs no bypass either: it satisfies the rules like
anyone else.

That is deliberate, and it is what keeps this file self-contained. Granting a
bypass would mean naming either a GitHub App's ID or a deploy key — values that
only exist after manual setup elsewhere, so the reviewed declaration would stop
describing the whole configuration.

`bypass_actors` is present and empty rather than absent, so that the intent reads
as a decision rather than an omission. It once named the built-in GitHub Actions
app, which is not an app installable on a repository and therefore not a valid
`Integration` actor — the import failed with `The ruleset you are importing
contains an invalid actor`, and the entry was never applied at all.

A ruleset is **not** read from the repository. It is a server-side setting, and
`.github/rulesets/main.json` is this project's own convention: the reviewed
declaration of what the setting should be. Something has to carry it across.

CI cannot: creating or updating a ruleset goes through the repository
administration API, and `administration` is not a permission a workflow can grant
`GITHUB_TOKEN`. So applying is a deliberate act by someone with admin, and the
configuration being in place is taken as a given afterwards.

There is deliberately no workflow checking that. A check could only report, never
enforce: if the ruleset were missing then `atoma-check` would no longer be a required
context either, so a failing check would block nothing — a permanently red mark
that stops nobody, which is worse than no mark at all.

**From the web UI** — easiest, and needs nothing installed:

> Settings → Rules → Rulesets → *New ruleset* → **Import a ruleset**, then upload
> `.github/rulesets/main.json`.

If the import option is unavailable, create it through the form instead and set:
target the default branch; restrict deletions; block force pushes; require a pull
request with **0** required approvals; and require the `atoma-check` status check. Leave
the bypass list empty.

**From a shell** — if you already have an admin-scoped `gh` login:

```bash
gh api --method POST repos/yuma-seno/atoma-autonomous-delivery/rulesets \
  --input .github/rulesets/main.json
```

To change the rules later, edit the JSON in a pull request, then re-import (or
`gh api --method PUT repos/<repo>/rulesets/<id> --input ...`). Nothing detects a
ruleset edited in the UI without a matching change to the file, so keeping the two
together is a discipline rather than something enforced.

One setting in that file exists for a specific reason. Required approvals is **0**
because Atoma's agents share one bot identity and GitHub forbids self-approval —
requiring an approval would deadlock the autonomous path. Repository admins are
deliberately **not** bypassed either; see above on why the bypass list is empty.

## Cutting a release

Bump `version` in `package.json` and merge it. That is the whole procedure.

The version is the single declaration, and `scripts/release.sh` derives the tag
from it, so there is no tag to push and nothing that can disagree. Releasing is an
ordinary reviewed change rather than a separate act of remembering.

That script is this project's one `deploy.targets` entry, declared `on: merge` in
`.github/atoma/config.json`. It runs after every merge and is idempotent: it reads
the declared version, finds a release already exists for it, and stops before
installing anything. Only a merge that changes the version reaches the build,
where it packages `dist/` as `atoma-delivery.zip` with `.github/` at the archive
root and creates the release — the tag included, via `--target`, so a tag never
exists without a release behind it.

Nothing writes to main, so none of this needs a ruleset bypass.

Both kinds of merge reach it, by different routes. Yours fires `push` on the
default branch, which `atoma-deploy.yml` listens for. An agent's fires nothing —
GitHub starts no workflow run for events its own token triggers — so `mergePr`
dispatches the workflow explicitly.

To publish by hand, or to retry a failed run:

```bash
gh workflow run atoma-deploy.yml --ref main -f target=release
```

## Setup (Bun)

```bash
bun install
```

Required engine in this repository is Bun `>=1.2.0`.

## Validation commands

```bash
bun run typecheck
bun run synth
bun run test
bun run test:e2e
```

What each command proves:

- `typecheck`: static type contract for scripts/workflows/shared libs.
- `synth`: workflow generation and deliverable build to `dist/.github`.
- `test`: unit-level behavior across `src/domain`, `src/lib`, `src/scripts`, and MCP/hook scripts.
- `test:e2e`: end-to-end checks in `tests/e2e`.

`test:e2e` runs against the built tree, so `bun run synth` has to come first — it
reads `dist/.github/atoma/tools/scripts/mcp/*.ts`, which an untracked `dist/` does
not have until you build it.

## Generated-file discipline

- **`dist/` is gitignored.** There is nothing generated to commit, and nothing to
  keep in sync with `src/`. Change `src/*` and let a release build it.
- Run `bun run synth` locally whenever you want to inspect what adopters will
  receive. CI runs it on every pull request, before `test`, to prove the
  deliverable still builds.
- `dist/.github/*` is generated: never hand-edit it.
- `.github/atoma/*` is *deployed*, not generated on merge. Nothing regenerates it
  — it is this repository's own adoption of the deliverable, upgraded by the
  one-liner in the source-of-truth map above and reviewed like any other change.
  So a change to `src/atoma/` does not reach the live agents until someone runs
  that upgrade, and CI does not reject a diff that touches it. Two exceptions
  inside it are genuinely yours to edit: `config.json` (which the upgrade
  restores) and `skills/project/`, which the deliverable does not contain.

## PR checklist

- Describe behavior changes from an adopter perspective.
- Include exact commands you ran and outcomes.
- Do not include `.github/atoma`; it is upgraded deliberately, not per pull
  request. `dist/` cannot appear at all — it is gitignored.
- Avoid unrelated refactors in the same PR.
- If you changed workflow dispatch semantics, call out backward compatibility impact explicitly.

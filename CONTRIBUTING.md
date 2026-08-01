# Contributing

## Source-of-truth map

Everything here divides into two kinds: **the deliverable**, which adopters
receive, and **this repository's own tooling**, which they must never see.

The deliverable:

- `src/`: hand-authored source for the template — agent definitions, skills, MCP
  servers, workflow definitions. Adopter-agnostic by rule: no reference to this
  repository's build pipeline, no incident history, no PR numbers.
- `dist/.github/`: generated from `src/`. This is what adopters copy. Produced by
  the `publish-dist` job in cd.yml, never committed by a pull request.

This repository's own:

- top-level `.github/`: this repository's adoption of the deliverable, plus
  `workflows/ci.yml`. Upgraded deliberately, not on merge:
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
until the `check` job passes. The only bypass is the GitHub Actions app, which
`publish-dist` runs as to commit `dist/`.

A ruleset is **not** read from the repository. It is a server-side setting, and
`.github/rulesets/main.json` is this project's own convention: the reviewed
declaration of what the setting should be. Something has to carry it across.

CI cannot: creating or updating a ruleset goes through the repository
administration API, and `administration` is not a permission a workflow can grant
`GITHUB_TOKEN`. So applying is a deliberate act by someone with admin, and the
configuration being in place is taken as a given afterwards.

There is deliberately no workflow checking that. A check could only report, never
enforce: if the ruleset were missing then `check` would no longer be a required
context either, so a failing check would block nothing — a permanently red mark
that stops nobody, which is worse than no mark at all.

**From the web UI** — easiest, and needs nothing installed:

> Settings → Rules → Rulesets → *New ruleset* → **Import a ruleset**, then upload
> `.github/rulesets/main.json`.

If the import option is unavailable, create it through the form instead and set:
target the default branch; restrict deletions; block force pushes; require a pull
request with **0** required approvals; require the `check` status check; and add
**GitHub Actions** as the only bypass actor.

**From a shell** — if you already have an admin-scoped `gh` login:

```bash
gh api --method POST repos/yuma-seno/atoma-autonomous-delivery/rulesets \
  --input .github/rulesets/main.json
```

To change the rules later, edit the JSON in a pull request, then re-import (or
`gh api --method PUT repos/<repo>/rulesets/<id> --input ...`). Nothing detects a
ruleset edited in the UI without a matching change to the file, so keeping the two
together is a discipline rather than something enforced.

Two settings in that file exist for specific reasons. Required approvals is **0**
because Atoma's agents share one bot identity and GitHub forbids self-approval —
requiring an approval would deadlock the autonomous path. The sole bypass actor is
the GitHub Actions app, which `publish-dist` runs as to commit `dist/`; it is safe
to bypass precisely because GitHub refuses to let an App write
`.github/workflows/`, so that identity provably cannot alter a workflow
definition. Repository admins are deliberately **not** bypassed.

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

Optional strict check:

```bash
bun run synth:check
```

This fails when generated `dist/` content is out of sync.

## Generated-file discipline

- Do not hand-edit `dist/.github/*` or `.github/atoma/*`. Both are generated.
- **Do not commit generated output in a pull request.** Change `src/*` only; the
  deploy job regenerates `dist/` and redeploys `.github/` after the merge. CI
  rejects a pull request whose diff touches `dist/` or `.github/atoma/`.
- Run `bun run synth` locally whenever you want to inspect what adopters will
  receive, then discard the result. CI runs it on every pull request to prove the
  deliverable still builds.
- `.github/workflows/*.yml` is the one exception: the deploy job authenticates as
  an App, which GitHub forbids from writing workflow files, so those changes have
  to arrive in a human-authored pull request.

## PR checklist

- Describe behavior changes from an adopter perspective.
- Include exact commands you ran and outcomes.
- Do not include `dist/.github` or `.github/atoma`; the deploy job owns them.
- Avoid unrelated refactors in the same PR.
- If you changed workflow dispatch semantics, call out backward compatibility impact explicitly.

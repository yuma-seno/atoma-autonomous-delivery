# Contributing

## Source-of-truth map

Everything here divides into two kinds: **the deliverable**, which adopters
receive, and **this repository's own tooling**, which they must never see.

The deliverable:

- `src/`: hand-authored source for the template — agent definitions, skills, MCP
  servers, workflow definitions. Adopter-agnostic by rule: no reference to this
  repository's build pipeline, no incident history, no PR numbers.
- `dist/.github/`: generated from `src/`. This is what adopters copy. Produced by
  the `publish-dist` CI job, never committed by a pull request.

This repository's own:

- top-level `.github/`: this repository's adoption of the deliverable, plus
  `workflows/ci.yml`. Upgraded deliberately with `bun run adopt:self`, not on
  merge. Project-specific agent rules live in `.github/atoma/skills/project/`.
- `tests/`: tests of the build-and-deploy machinery. Tests of *shipped behaviour*
  live beside the shipped code instead.
- `maintenance/`: scripts for operating this repository.
- `docs/`: adopter-facing documentation.

Beware two same-named directories that mean opposite things: `src/scripts/` is
deliverable code, bundled into `dist/.github/scripts/`; top-level `maintenance/`
is this repository's own. Nothing this repository needs for itself belongs
under `src/`.

When changing template behavior, treat `src/` as canonical.

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

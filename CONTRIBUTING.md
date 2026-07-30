# Contributing

## Source-of-truth map

- `src/`: hand-authored source code and workflow definitions.
- `dist/.github/`: generated deliverable artifacts for adopters.
- top-level `.github/`: this repository's own operational automation (dogfooding and CI runtime files).

When changing template behavior, treat `src/` as canonical and regenerate outputs.

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

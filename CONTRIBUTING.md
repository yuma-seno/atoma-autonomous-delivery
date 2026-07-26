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

- Do not hand-edit `dist/.github/*`.
- Edit `src/*`, run `bun run synth`, then commit regenerated output.
- Keep source and generated changes in the same PR.

## PR checklist

- Describe behavior changes from an adopter perspective.
- Include exact commands you ran and outcomes.
- Regenerate and include `dist/.github` when relevant.
- Avoid unrelated refactors in the same PR.
- If you changed workflow dispatch semantics, call out backward compatibility impact explicitly.

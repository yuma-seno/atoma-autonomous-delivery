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

## Never commit generated output

Change `src/**` only. Leave `dist/**` and `.github/atoma/**` out of your commit
entirely — the deploy job regenerates them after the merge, and CI rejects a pull
request whose diff contains them.

Do not run `bun run synth` to "keep them in sync". That is not your job, and its
output must not reach your commit. Run it only to inspect what adopters would
receive, then discard the result.

Two reasons this is enforced rather than encouraged: sub-issues are dispatched in
parallel, so two branches regenerating the same bundles collide in files no human
wrote; and a regenerated bundle buries the `src/` change a reviewer has to read
under a diff orders of magnitude larger.

`.github/workflows/*.yml` is the sole exception. The deploy job authenticates as
an App, and GitHub refuses to let an App write workflow files, so a
human-authored pull request is their only route in.

## Adding a static file to the deliverable

A new non-code file under `src/atoma/` must also be added to `build-dist.ts`'s
verbatim-copy list, or it never reaches `dist/` and is silently deleted from
`.github/` on the next deploy. `tests/contract/deployment-contract.test.ts`
enforces this.

## Anything hand-added under `.github/`

It is deleted on the next deploy unless its path is listed in the deploy step's
`KEEP` array. Either add it there, or put it in `src/` and let it be generated.

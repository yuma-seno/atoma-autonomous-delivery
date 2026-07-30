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

Change `src/**` only. Keep `dist/**` out of your commit entirely — the
`publish-dist` job regenerates and commits it after the merge, and CI rejects a
pull request whose diff contains it.

Do not run `bun run synth` to "keep it in sync". That is not your job, and its
output must not reach your commit. Run it only to inspect what adopters would
receive, then discard the result.

Two reasons this is enforced rather than encouraged: sub-issues are dispatched in
parallel, so two branches regenerating the same bundles collide in files no human
wrote; and a regenerated bundle buries the `src/` change a reviewer has to read
under a diff orders of magnitude larger.

`.github/**` is a different matter — see below. It is not regenerated on merge, so
a change there is yours to make and review, not something to keep out.

## Adding a static file to the deliverable

A new non-code file under `src/atoma/` must also be added to `build-dist.ts`'s
verbatim-copy list, or it never reaches `dist/` at all.
`tests/contract/deployment-contract.test.ts` enforces this.

## `.github/` is an adoption, not a mirror

Nothing regenerates `.github/` automatically. It is this repository's deliberate
adoption of the deliverable, so it lags `src/` until someone upgrades it:

```bash
bun run synth && cp -r dist/.github/. .github/
```

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
`.github/workflows/`, so no automation can perform this step. That same
restriction is what lets `publish-dist` hold the branch-ruleset bypass safely: it
provably cannot alter a workflow definition.

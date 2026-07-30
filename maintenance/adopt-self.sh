#!/usr/bin/env bash
#
# adopt-self.sh — upgrade THIS repository's own Atoma configuration to the
# current deliverable, the same way an adopter would.
#
# `.github/` is not generated on every push any more. It is this repository's
# adoption of the template: deliberately upgraded, so a change to `src/` cannot
# reconfigure the live agents the instant it merges. Two production breakages
# reached the running system that way before this was split apart.
#
# Run this when you want the upgrade, then open a pull request with the result.
# It has to be run by a human: GitHub refuses to let an App write files under
# `.github/workflows/`, so no automation can perform this step.
#
#   bun run adopt:self && git switch -c chore/upgrade-atoma-template
#
set -euo pipefail

cd "$(dirname "$0")/.."

# Paths under .github/ this repository owns rather than adopts. Everything else
# is replaced wholesale from the deliverable.
KEEP=(workflows/ci.yml atoma/skills/project)

if [ ! -d dist/.github ]; then
  echo "dist/.github is missing; run 'bun run synth' first." >&2
  exit 1
fi

STASH=$(mktemp -d)
trap 'rm -rf "$STASH"' EXIT

for path in "${KEEP[@]}"; do
  if [ -e ".github/$path" ]; then
    mkdir -p "$STASH/$(dirname "$path")"
    cp -r ".github/$path" "$STASH/$path"
    echo "keeping .github/$path"
  fi
done

rm -rf .github
mkdir -p .github/workflows
cp -r dist/.github/. .github/

for path in "${KEEP[@]}"; do
  if [ -e "$STASH/$path" ]; then
    mkdir -p ".github/$(dirname "$path")"
    cp -r "$STASH/$path" ".github/$path"
  fi
done

echo
echo "Upgraded .github/ from dist/.github/. Review and commit:"
git --no-pager status --short -- .github

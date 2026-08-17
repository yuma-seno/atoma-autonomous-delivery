#!/usr/bin/env bash
#
# release.sh — publish the deliverable as a release asset.
#
# The deployment this project declares in `deploy.targets`. Everything a release
# does is here, in a file an agent can write, rather than in a workflow file it
# cannot — which is the whole reason the pipeline moved into configuration.
#
# The version is not passed in. `package.json`'s `version` is the single
# declaration and the tag is derived from it, so the two cannot disagree and
# there is no separate tagging step to remember. Releasing is therefore an
# ordinary reviewed change: bump the version, and merging it publishes.
#
# Idempotent, and that is what makes `on: merge` safe. This runs after every
# merge, finds a release already exists for the declared version, and stops
# before installing anything. Only a merge that changes the version reaches the
# build.
set -euo pipefail

VERSION=$(jq -r '.version // empty' package.json)
if [ -z "$VERSION" ]; then
  echo "::error::package.json declares no version; nothing can be released."
  exit 1
fi

# The version reaches a tag name and a filename, so keep it to a shape that
# cannot mean anything else.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::package.json version '$VERSION' is not a plain semver string."
  exit 1
fi

TAG="v$VERSION"
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "$TAG is already released; nothing to do."
  exit 0
fi
echo "$TAG has no release yet; building it."

bun install --frozen-lockfile
bun run synth

if [ ! -d dist/.github ]; then
  echo "::error::synth produced no dist/.github; nothing to package."
  exit 1
fi

# `zip` from inside dist/ so the archive holds `.github/...` and not
# `dist/.github/...`, and an adopter extracts it at their repository root.
# Naming `.github` explicitly is what includes it; a bare `zip -r .` would skip
# the dotfile entry.
#
# Deliberately a fixed asset name rather than one carrying the version: it is
# what makes `releases/latest/download/atoma-delivery.zip` a stable URL, and the
# version is already carried by the release itself.
(cd dist && zip -qr ../atoma-delivery.zip .github)
unzip -l atoma-delivery.zip | tail -1

# `--target` is what creates the tag, so there is no separate tag push and no
# window where a tag exists without a release behind it.
gh release create "$TAG" atoma-delivery.zip \
  --title "$TAG" \
  --target "$GITHUB_SHA" \
  --generate-notes

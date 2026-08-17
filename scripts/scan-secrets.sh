#!/usr/bin/env bash
#
# scan-secrets.sh — scan this branch's commits for leaked credentials.
#
# Runs first among this project's checks, before anything builds: a leaked
# credential is worth knowing about whether or not the code compiles.
#
# Scans this branch's commits, not the whole history. History is scanned by
# nobody here on purpose — an old finding is not something this pull request can
# fix, and failing every pull request over one teaches people to ignore the
# check. Scan history deliberately, by hand, when you want to know.
#
# Agents commit through this same gate: their pull request runs the configured
# checks like any other, and a merge waits on the result.
set -euo pipefail

# `atoma-check.yml` checks out shallow, and a merge base cannot be computed from
# one commit. Tolerated rather than required: a repository that is already
# complete refuses to unshallow, which is not a failure.
git fetch --quiet --unshallow origin 2>/dev/null || true

# Works the same on both triggers. A pull request sets GITHUB_BASE_REF; a
# dispatch — the agent path — does not, and falls back to main, which is where
# their branches start.
BASE_REF="${GITHUB_BASE_REF:-main}"
git fetch --quiet origin "$BASE_REF"
RANGE="$(git merge-base FETCH_HEAD HEAD)..HEAD"
echo "Scanning $RANGE"

# Latest rather than a pinned version: the value of a secret scanner is its rule
# set, and pinning freezes it at whatever was current the day someone wrote the
# number down. Pin it here if you would rather review each update.
TAG=$(gh api repos/gitleaks/gitleaks/releases/latest --jq .tag_name)
curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/${TAG}/gitleaks_${TAG#v}_linux_x64.tar.gz" |
  tar -xz -C /tmp gitleaks

/tmp/gitleaks git --log-opts="$RANGE" --redact --verbose --no-banner .

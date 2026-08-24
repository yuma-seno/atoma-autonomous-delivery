#!/usr/bin/env bash
#
# probe-tool-health.sh — install the pinned Atoma CLI, then run probe-tool-health.ts
# against it.
#
# The released binary rather than a build of main, because what is being checked is
# the thing the runner will actually download: `ATOMA_DEFAULT_VERSION` in
# `src/workflows/actions/atoma-cli.ts` is the version an agent runs under, so it is
# the version this asks about. Read from there rather than written twice.
#
# The measurement itself is in the .ts -- see its header for what and why.
set -uo pipefail

VERSION="$(grep -o 'ATOMA_DEFAULT_VERSION = "[^"]*"' src/workflows/actions/atoma-cli.ts | head -1 | sed 's/.*"\(.*\)"/\1/')"
if [ -z "${VERSION}" ]; then
  echo "could not read ATOMA_DEFAULT_VERSION" >&2
  exit 1
fi
printf 'RESULT pinned_version=%s\n' "${VERSION}"

BIN="${RUNNER_TEMP:-/tmp}/atoma-probe"
URL="https://github.com/yuma-seno/atoma/releases/download/${VERSION}/atoma-linux-x86_64"
curl -fsSL "${URL}" -o "${BIN}" || { echo "could not download ${URL}" >&2; exit 1; }
chmod +x "${BIN}"
printf 'RESULT installed=%s\n' "$("${BIN}" --version 2>&1 | head -1)"

ATOMA_BIN="${BIN}" bun run scripts/probe-tool-health.ts

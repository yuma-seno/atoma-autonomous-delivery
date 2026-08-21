#!/usr/bin/env bash
#
# probe-preload.sh — can a process be made unreadable without changing its code?
#
# `prctl(PR_SET_DUMPABLE, 0)` makes a process's `/proc/<pid>/environ` unreadable to
# the same user, which is what removes the need to isolate the shell at all. Two
# facts complicate it, both measured already:
#
#   - it does not survive `execve`, so a wrapper cannot set it for a program
#   - so the program has to call it in its own process
#
# The second is a problem twice over. A third-party tool server will not call it.
# And OUR servers spawn children that hold the credential -- `github` runs `gh`
# with GH_TOKEN in its environment, and that child is dumpable again.
#
# `LD_PRELOAD` closes both if it works here: a shared library's constructor runs
# AFTER exec, inside the new process, so the flag sticks. And LD_PRELOAD is itself
# an environment variable, so every descendant inherits it.
#
# That would make this a one-line prefix in `tools.yaml` covering our servers,
# third-party servers, and their children alike -- no code change anywhere.
#
# Four questions:
#
#   1. Can the library be built here at all? (a compiler is a new dependency)
#   2. Does it work on a dynamically linked program (bun)?
#   3. **Does it work on `gh`?** It is written in Go, and a static binary ignores
#      LD_PRELOAD entirely. This is the one that decides whether the child-process
#      hole closes this way.
#   4. Do children inherit it?
#
# Every answer prints as `RESULT <name>=<value>`.
set -uo pipefail

say() { printf '\n=== %s ===\n' "$1"; }
result() { printf 'RESULT %s=%s\n' "$1" "$2"; }

OUT=/tmp/preload
rm -rf "$OUT"; mkdir -p "$OUT"

# ── 1. build it ──────────────────────────────────────────────────────────────
say "1. building the library"
result compiler "$(command -v gcc || command -v cc || echo missing)"
cat > "$OUT/nondumpable.c" <<'C'
#include <sys/prctl.h>
__attribute__((constructor)) static void harden(void) { prctl(PR_SET_DUMPABLE, 0, 0, 0, 0); }
C
if gcc -shared -fPIC -O2 -o "$OUT/nondumpable.so" "$OUT/nondumpable.c" 2>"$OUT/build.err"; then
  result built yes
  result built_size "$(stat -c '%s' "$OUT/nondumpable.so") bytes"
else
  result built no
  result build_error "$(tr '\n' ' ' < "$OUT/build.err" | head -c 200)"
fi

# Reports whether a pid is dumpable, from outside, by the owner of its /proc entry.
# root means non-dumpable; the invoking user means dumpable.
owner_of() { stat -c '%U' "/proc/$1/environ" 2>/dev/null || echo unknown; }
readable() { sh -c "cat /proc/$1/environ >/dev/null 2>&1 && echo yes || echo no"; }

# ── 2. a dynamically linked program ──────────────────────────────────────────
say "2. a dynamically linked program (bun)"
result bun_is_dynamic "$(file -L "$(command -v bun)" 2>/dev/null | grep -qi "dynamically linked" && echo yes || echo no)"
PROBE_SECRET=preload-secret LD_PRELOAD="$OUT/nondumpable.so" bun -e "await Bun.sleep(60000)" &
BUN_PID=$!
sleep 3
result bun_preloaded_proc_owner "$(owner_of "$BUN_PID")"
result bun_preloaded_environ_readable "$(readable "$BUN_PID")"
kill "$BUN_PID" 2>/dev/null || true

# The control, so the two are read against each other on this runner.
PROBE_SECRET=preload-secret bun -e "await Bun.sleep(60000)" &
BUN2=$!
sleep 3
result bun_plain_proc_owner "$(owner_of "$BUN2")"
result bun_plain_environ_readable "$(readable "$BUN2")"
kill "$BUN2" 2>/dev/null || true

# ── 3. gh, which is the one that matters ─────────────────────────────────────
#
# Asked by LINKAGE rather than by running it. `gh` subcommands that stay alive
# need credentials, and the ones that do not exit in milliseconds -- sampling
# /proc for those is a race that reports "unknown" as often as an answer.
#
# Linkage decides it outright: LD_PRELOAD is honoured by the dynamic loader, so a
# statically linked binary never consults it. `gh` is written in Go, where static
# is the usual outcome.
say "3. gh"
GH=$(command -v gh || echo missing)
result gh_path "$GH"
result gh_file "$(file -L "$GH" 2>/dev/null | sed 's/^[^:]*: //' | head -c 140)"
result gh_dynamic "$(ldd "$GH" >/dev/null 2>&1 && echo yes || echo no)"
result gh_interpreter "$(ldd "$GH" 2>&1 | head -c 140)"

# ── 4. inheritance ───────────────────────────────────────────────────────────
say "4. does a child inherit it"
# LD_PRELOAD is an environment variable, so a child gets it and its own
# constructor runs. `sleep` is a dynamically linked binary we did not write --
# which is exactly the third-party case.
LD_PRELOAD="$OUT/nondumpable.so" sh -c 'exec sleep 60' &
CHILD=$!
sleep 2
result child_of_preloaded_proc_owner "$(owner_of "$CHILD")"
result child_of_preloaded_environ_readable "$(readable "$CHILD")"
kill "$CHILD" 2>/dev/null || true

sh -c 'exec sleep 60' &
CHILD2=$!
sleep 2
result child_plain_proc_owner "$(owner_of "$CHILD2")"
kill "$CHILD2" 2>/dev/null || true

say "reading the result"
cat <<'NOTE'
bun_preloaded_proc_owner=root and child_of_preloaded_proc_owner=root
   -> a one-line prefix in tools.yaml covers a server AND everything it spawns,
      with no code change in either. That is the whole design.
gh_preloaded_proc_owner=root
   -> the `gh` window closes too.
gh_preloaded_proc_owner=runner (or gh_linkage says statically linked)
   -> LD_PRELOAD cannot reach it, and the github server has to stop putting the
      token in a child's environment -- calling the API over HTTP instead of
      shelling out to gh.
NOTE

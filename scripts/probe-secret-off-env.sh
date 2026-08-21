#!/usr/bin/env bash
#
# probe-secret-off-env.sh — can a credential be held where a same-user process
# cannot reach it?
#
# #464 started as "isolate the shell with a uid". That closes the hole but leaves
# `$HOME` meaning two things, which is the confusion it was meant to remove. The
# alternative is to stop protecting the process and protect the VALUE: if the
# credential is not in an environment block and the holder's memory is unreadable,
# then a same-user shell has nothing to take and needs no isolation at all --
# same user, same HOME, no container, no ACL, no divergence.
#
# core's own `process_protection.rs` already argues for it: "Not a substitute for
# keeping credentials out of environment blocks in the first place... Only never
# putting it there works."
#
# Three questions, and the design stands or falls on the first:
#
#   1. Can a Bun process make ITSELF non-dumpable? `PR_SET_DUMPABLE(0)` does not
#      survive `execve` -- measured -- so atoma cannot do it on a server's behalf.
#      The server has to call `prctl`, and Bun reaches libc through `bun:ffi`.
#
#   2. With the credential off the environment, is it absent from `environ`?
#
#   3. Non-dumpable, is `/proc/<pid>/mem` refused to the same user? core's table
#      says yes; re-asked here because the whole design rests on it and because
#      that table also says the unprotected case depends on the host's
#      `ptrace_scope`, which nobody here controls.
#
# Every answer prints as `RESULT <name>=<value>`.
set -uo pipefail

say() { printf '\n=== %s ===\n' "$1"; }
result() { printf 'RESULT %s=%s\n' "$1" "$2"; }

# Deliberately low-entropy and obviously not a credential: the hex-suffixed value
# this used to be tripped the secret scanner in this repository own checks, which
# was correct by its rules -- a fixture should not look like a key.
SECRET="this-is-not-a-credential-it-is-a-probe-fixture"
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=/tmp/secret-probe
rm -rf "$OUT"; mkdir -p "$OUT"

# Reads a pid's environ and its heap, and says whether the secret was in either.
cat > "$OUT/reader.py" <<'PY'
import sys
pid, secret = sys.argv[1], sys.argv[2]

def environ():
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            return "found" if secret.encode() in f.read() else "absent"
    except PermissionError:
        return "refused-eacces"
    except Exception as e:
        return f"refused-{type(e).__name__}"

def heap():
    try:
        regions = []
        with open(f"/proc/{pid}/maps") as f:
            for line in f:
                if not line.rstrip().endswith(("[heap]", "[stack]")) and " rw" not in line:
                    continue
                span, perms = line.split()[0], line.split()[1]
                if "r" not in perms:
                    continue
                lo, hi = (int(x, 16) for x in span.split("-"))
                if hi - lo <= 64 * 1024 * 1024:
                    regions.append((lo, hi))
        if not regions:
            return "no-readable-regions"
        with open(f"/proc/{pid}/mem", "rb") as mem:
            for lo, hi in regions[:400]:
                try:
                    mem.seek(lo)
                    if secret.encode() in mem.read(hi - lo):
                        return "found"
                except Exception:
                    continue
        return "absent"
    except PermissionError:
        return "refused-eacces"
    except Exception as e:
        return f"refused-{type(e).__name__}"

print(f"{environ()} {heap()}")
PY

result ptrace_scope "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo absent)"

round() {
  local label="$1" mode="$2"
  local pidfile="$OUT/$label.json"
  if [ "$mode" = "env" ] || [ "$mode" = "env+nd" ]; then
    PROBE_SECRET="$SECRET" bun run "$HERE/probe-secret-holder.ts" "$mode" "$pidfile" </dev/null &
  else
    printf '%s\n' "$SECRET" | bun run "$HERE/probe-secret-holder.ts" "$mode" "$pidfile" &
  fi
  for _ in $(seq 1 100); do [ -s "$pidfile" ] && break; sleep 0.2; done
  if [ ! -s "$pidfile" ]; then result "${label}_started" "no"; return; fi

  result "${label}_ffi_called" "$(python3 -c "import json;print(json.load(open('$pidfile'))['ffi_called'])")"
  result "${label}_dumpable_after" "$(python3 -c "import json;print(json.load(open('$pidfile'))['dumpable_after'])")"
  result "${label}_ffi_error" "$(python3 -c "import json;print(json.load(open('$pidfile'))['ffi_error'])")"
  result "${label}_holds_secret_of_length" "$(python3 -c "import json;print(json.load(open('$pidfile'))['secret_length'])")"

  local pid
  pid=$(python3 -c "import json;print(json.load(open('$pidfile'))['pid'])")
  result "${label}_proc_owner" "$(stat -c '%U' "/proc/$pid/environ" 2>/dev/null || echo unknown)"
  # Same user, different process -- exactly the shell server's position.
  set -- $(python3 "$OUT/reader.py" "$pid" "$SECRET")
  result "${label}_environ" "${1:-unknown}"
  result "${label}_memory" "${2:-unknown}"
  kill "$pid" 2>/dev/null || true
}

say "1. the control — the credential in the environment block, as today"
round env env

say "2. the credential off the environment, on the heap"
round stdin stdin

say "3. the same, and the holder makes itself non-dumpable"
round hardened "stdin+nd"

say "4. the credential stays in the environment, and the holder makes itself non-dumpable"
# The arrangement the design now rests on: nothing about how atoma delivers a
# credential changes, and the process it lands in is simply unreadable. Measured
# separately because round 3 took the value OFF the environment, so it could not
# show that a value still in there is protected.
round env_hardened "env+nd"

say "reading the result"
cat <<'NOTE'
hardened_ffi_called=true and
hardened_dumpable_after=0   -> a Bun server CAN make itself unreadable, which is what
                               the whole alternative rests on. atoma cannot do it for
                               the server: the flag does not survive execve.
stdin_environ=absent        -> taking the value off the environment removes it from
                               the one place a same-user process can always read.
hardened_memory=refused-*   -> and the heap is closed too, without depending on the
                               host's ptrace_scope.

All three -> the shell needs no isolation at all: same user, same HOME, no container,
             no ACL, and nothing for it to take.
Any one failing -> back to isolating the process, and $HOME keeps meaning two things.
NOTE

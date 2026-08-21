#!/usr/bin/env bash
#
# probe-dumpable.sh — the measurement #464 turns on.
#
# Three questions, in the order they decide things:
#
#   1. Does `PR_SET_DUMPABLE(0)` survive `execve` into an ordinary binary?
#      If it does, every MCP server atoma spawns is already non-dumpable, and the
#      premise #374's container was built on -- "a same-user process can read the
#      environ of the servers that hold credentials" -- does not hold.
#
#   2. With the flag NOT set, can a same-user process read another's environ?
#      The baseline `process_protection.rs` measured. Re-asked so the answer to 1
#      is read against a control on the same runner, not a table from another one.
#
#   3. Can a DIFFERENT uid read it either way?
#      The mechanism #464 proposes.
#
# And a fourth, because a uid does not close it: is a world-writable directory
# really on PATH, where a fake `gh` would be found before the real one.
#
# Nothing here tests Atoma. These are properties of the kernel and the runner
# image, so they are asked directly -- no atoma binary, no model call, no tool
# servers. Every answer prints as `RESULT <name>=<value>`.
#
# ## Two corrections from the first version, both worth keeping written down
#
# It read dumpability from `/proc/self/status`. **There is no `Dumpable` field
# there.** The parse raised, the holder died before it could report, and the
# question this probe exists for came back `unknown` while three other answers
# looked fine. `prctl(PR_GET_DUMPABLE)` is the way to read it.
#
# It also tested PATH entries with `stat -c '%A'`, which does not follow symlinks
# -- so every symlink reported `lrwxrwxrwx` and counted as world-writable. `/bin`
# and `/sbin` are symlinks on this image, and both were false positives.
set -uo pipefail

say() { printf '\n=== %s ===\n' "$1"; }
result() { printf 'RESULT %s=%s\n' "$1" "$2"; }

PROBE=/tmp/probe
rm -rf "$PROBE"; mkdir -p "$PROBE"; chmod 777 /tmp "$PROBE" 2>/dev/null || true

# ── the pieces ───────────────────────────────────────────────────────────────

# Reports its own dumpability, records its pid, and holds a marker in its
# environment so a reader can prove it read the real block.
cat > /tmp/holder.py <<'PY'
import ctypes, os, sys, time
libc = ctypes.CDLL("libc.so.6", use_errno=True)
PR_SET_DUMPABLE, PR_GET_DUMPABLE = 4, 3
if sys.argv[1] == "protect":
    libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
name = sys.argv[2]
# prctl, not /proc/self/status -- that file has no Dumpable field.
open(f"/tmp/probe/{name}.dumpable", "w").write(str(libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0)))
open(f"/tmp/probe/{name}.owner", "w").write(
    __import__("pwd").getpwuid(os.stat(f"/proc/{os.getpid()}/environ").st_uid).pw_name
)
open(f"/tmp/probe/{name}.pid", "w").write(str(os.getpid()))
time.sleep(180)
PY

# Sets the flag and then EXECs the holder, with credentials unchanged -- which is
# how atoma spawns a server. Whatever the holder then reports is the answer to 1.
cat > /tmp/exec_then_hold.py <<'PY'
import ctypes, os
libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.prctl(4, 0, 0, 0, 0)
open("/tmp/probe/before-exec.dumpable", "w").write(str(libc.prctl(3, 0, 0, 0, 0)))
os.execv("/usr/bin/python3", ["python3", "/tmp/holder.py", "keep", "inherited"])
PY

cat > /tmp/reader.py <<'PY'
import sys
try:
    with open(f"/proc/{sys.argv[1]}/environ", "rb") as f:
        body = f.read().decode("utf8", "replace")
    print("read-marker" if "MARKER" in body else "read-no-marker")
except PermissionError:
    print("refused-eacces")
except Exception as e:
    print(f"refused-{type(e).__name__}")
PY

wait_for() { for _ in $(seq 1 60); do [ -s "$1" ] && return 0; sleep 0.2; done; return 1; }
read_or() { cat "$1" 2>/dev/null || echo unknown; }

# ── 1. does the flag survive execve? ─────────────────────────────────────────
say "1. PR_SET_DUMPABLE(0) across execve"
MARKER=secret-value python3 /tmp/exec_then_hold.py &
wait_for "$PROBE/inherited.pid" || echo "(the exec'd holder never reported)"
result before_exec_dumpable "$(read_or "$PROBE/before-exec.dumpable")"
result after_exec_dumpable "$(read_or "$PROBE/inherited.dumpable")"
# A non-dumpable process has its /proc entries owned by root. Reported as a second,
# independent view of the same fact.
result after_exec_proc_owner "$(read_or "$PROBE/inherited.owner")"
INHERITED_PID=$(read_or "$PROBE/inherited.pid")
result same_uid_read_of_protected "$(python3 /tmp/reader.py "$INHERITED_PID" 2>&1 | tail -1)"

# ── 2. the control ───────────────────────────────────────────────────────────
say "2. control — a holder that never set the flag"
MARKER=secret-value python3 /tmp/holder.py plain plain &
wait_for "$PROBE/plain.pid" || echo "(the plain holder never reported)"
PLAIN_PID=$(read_or "$PROBE/plain.pid")
result plain_dumpable "$(read_or "$PROBE/plain.dumpable")"
result plain_proc_owner "$(read_or "$PROBE/plain.owner")"
result same_uid_read_of_plain "$(python3 /tmp/reader.py "$PLAIN_PID" 2>&1 | tail -1)"

# ── 3. a different uid ───────────────────────────────────────────────────────
say "3. a different uid"
sudo useradd -m probeuser 2>/dev/null || true
result different_uid_exists "$(id -u probeuser >/dev/null 2>&1 && echo yes || echo no)"
result different_uid_read_of_plain "$(sudo -u probeuser python3 /tmp/reader.py "$PLAIN_PID" 2>&1 | tail -1)"
result different_uid_read_of_protected "$(sudo -u probeuser python3 /tmp/reader.py "$INHERITED_PID" 2>&1 | tail -1)"

# ── 4. the PATH half, which a uid does NOT close ─────────────────────────────
say "4. world-writable directories on PATH"
WRITABLE=""
for dir in ${PATH//:/ }; do
  # -L, because a symlink's own mode is always lrwxrwxrwx and every one of them
  # counted as world-writable in the first version of this probe.
  [ -d "$dir" ] || continue
  perms=$(stat -L -c '%A' "$dir" 2>/dev/null || echo "")
  case "$perms" in *w?) WRITABLE="$WRITABLE $dir($perms)";; esac
done
result world_writable_on_path "${WRITABLE:-none}"
for dir in /usr/local/bin /usr/bin /bin; do
  result "other_uid_can_write_${dir//\//_}" \
    "$(sudo -u probeuser sh -c "touch $dir/probe-fake 2>/dev/null && echo yes || echo no")"
  sudo rm -f "$dir/probe-fake" 2>/dev/null || true
done

pkill -f /tmp/holder.py 2>/dev/null || true

say "reading the result"
cat <<'NOTE'
after_exec_dumpable=0  -> the flag survives execve. Every server atoma spawns is
                          already non-dumpable, and #374's environ premise does
                          not hold. #464 becomes a PATH fix plus a uid.
after_exec_dumpable=1  -> it does not survive. The servers holding credentials
                          are readable by a same-uid process, and a different uid
                          is what closes it.
NOTE

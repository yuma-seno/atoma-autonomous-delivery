#!/usr/bin/env bash
#
# probe-tool-user.sh — the arrangement #464 lands on, run end to end before it is
# written into the runner.
#
# The decision: every tool server runs as one dedicated OS user that is not in
# sudoers. Same user for all of them, so no tool sees a different environment from
# another -- which is the property the container could not give. `$HOME` points at
# the runner's home so the toolchain resolves, readable and not writable, the same
# for every tool.
#
# What is protected, and what is not, is a decision rather than a mechanism: the
# three properties "one environment", "secrets hidden from the shell" and
# "arbitrary third-party servers" cannot hold together, and the guarantee for the
# third is what was given up. See #464.
#
# Everything here is a mechanic the runner will depend on. Each one has cost a
# round trip before, in this repository's history, so each is asked directly:
#
#   1. the user can be created, and has no sudo
#   2. it can reach and write the workspace, and the runner can edit back
#   3. it can execute bun, which lives in the runner's HOME
#   4. HOME is readable and NOT writable, and a redirected cache is writable
#   5. `sudo -u` passes an environment through in a form that works
#   6. git, as the runner, still handles what that user wrote
set -uo pipefail

say() { printf '\n=== %s ===\n' "$1"; }
result() { printf 'RESULT %s=%s\n' "$1" "$2"; }
yn() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }

U=atoma-tools
WS="$HOME/work/probe-repo/probe-repo"
CACHE=/tmp/atoma-tool-cache

# ── 1. the user ──────────────────────────────────────────────────────────────
say "1. the user"
# -M no home, -N no group of its own, nologin: it is never logged into, only
# `sudo -u`'d into. Nothing puts it in sudoers, which is the point.
sudo useradd -M -N -s /usr/sbin/nologin "$U" 2>/dev/null || true
result user_exists "$(id -u "$U" >/dev/null 2>&1 && echo yes || echo no)"
result user_groups "$(id -nG "$U" 2>/dev/null || echo unknown)"
# The whole design rests on this being "no".
result user_has_sudo "$(sudo -u "$U" sudo -n true 2>/dev/null && echo yes || echo no)"

# ── 2. the workspace ─────────────────────────────────────────────────────────
say "2. the workspace"
rm -rf "$HOME/work/probe-repo"; mkdir -p "$WS"
git -C "$WS" init -q
git -C "$WS" config user.name probe
git -C "$WS" config user.email probe@example.com
echo original > "$WS/tracked.txt"
git -C "$WS" add tracked.txt
git -C "$WS" commit -qm initial

result reaches_before "$(yn sudo -u "$U" cat "$WS/tracked.txt")"

# Traversal down to the workspace, granted per user rather than by mode: `x`
# without `r` lets it reach the tree without being able to list the home
# directory the tree sits under. Walked rather than hardcoded -- the path between
# HOME and the workspace is the runner's business, not ours.
DIR="$WS"
while [ "$DIR" != "$HOME" ] && [ "$DIR" != "/" ]; do
  DIR=$(dirname "$DIR")
  sudo setfacl -m "u:$U:x" "$DIR" 2>/dev/null || echo "(setfacl x failed on $DIR)"
done
sudo setfacl -m "u:$U:x" "$HOME" 2>/dev/null || echo "(setfacl x failed on HOME)"
# And full access inside it, for files that exist and files created later.
sudo setfacl -R -m "u:$U:rwX" "$WS" 2>/dev/null || echo "(setfacl rwX failed)"
sudo setfacl -R -d -m "u:$U:rwX" "$WS" 2>/dev/null || echo "(setfacl default failed)"
sudo setfacl -R -d -m "u:$(id -un):rwX" "$WS" 2>/dev/null || true

result reaches_after "$(yn sudo -u "$U" cat "$WS/tracked.txt")"
result lists_home "$(yn sudo -u "$U" ls "$HOME")"
result creates_in_workspace "$(yn sudo -u "$U" sh -c "echo from-tool > $WS/from-tool.txt")"
result created_mode "$(stat -L -c '%A %U:%G' "$WS/from-tool.txt" 2>/dev/null || echo missing)"
# The one that decides it: `filesystem__edit_file` edits in place.
result runner_edits_it "$(yn sh -c "echo more >> $WS/from-tool.txt")"
result tool_edits_runner_file "$(yn sudo -u "$U" sh -c "echo more >> $WS/tracked.txt")"
# A subdirectory the tool creates has to inherit the arrangement too.
result tool_creates_subdir "$(yn sudo -u "$U" sh -c "mkdir -p $WS/sub && echo x > $WS/sub/f")"
result runner_edits_in_subdir "$(yn sh -c "echo more >> $WS/sub/f")"

# ── 3. bun, which lives in the runner's HOME ─────────────────────────────────
say "3. bun"
BUN=$(command -v bun || echo missing)
result bun_path "$BUN"
result tool_runs_bun "$(sudo -u "$U" "$BUN" --version >/dev/null 2>&1 && echo yes || echo no)"

# ── 4. HOME and the cache ────────────────────────────────────────────────────
say "4. HOME readable, not writable; cache writable"
result tool_reads_home_file "$(yn sudo -u "$U" sh -c "test -d $HOME/.bun")"
result tool_writes_home "$(sudo -u "$U" sh -c "touch $HOME/probe-write 2>/dev/null && echo yes || echo no")"
rm -f "$HOME/probe-write"
install -d -m 0700 "$CACHE" && sudo chown "$U" "$CACHE"
result tool_writes_cache "$(sudo -u "$U" sh -c "touch $CACHE/x 2>/dev/null && echo yes || echo no")"

# ── 5. passing an environment through sudo ───────────────────────────────────
say "5. environment through sudo"
# `--preserve-env` needs a sudoers permission that may not be granted; `env` in
# front of the command always works. Both asked, so the runner uses the one that
# does.
result preserve_env "$(PROBE_VAR=carried sudo -n -u "$U" --preserve-env sh -c 'echo ${PROBE_VAR:-lost}' 2>/dev/null || echo denied)"
result env_prefix "$(sudo -n -u "$U" env PROBE_VAR=carried sh -c 'echo ${PROBE_VAR:-lost}')"
result home_override "$(sudo -n -u "$U" env HOME="$HOME" sh -c 'echo $HOME')"
result cwd_preserved "$(cd "$WS" && sudo -n -u "$U" pwd)"

# ── 6. git afterwards ────────────────────────────────────────────────────────
say "6. git, as the runner, over what the tool user wrote"
result git_status "$(git -C "$WS" status --porcelain | tr '\n' ' ')"
result git_add "$(yn git -C "$WS" add -A)"
result git_commit "$(yn git -C "$WS" commit -qm 'from the tool user')"

say "reading the result"
cat <<'NOTE'
user_has_sudo=no            -> the property everything else depends on.
runner_edits_it=yes and
runner_edits_in_subdir=yes  -> one environment, both directions, including files and
                               directories the tool creates later.
tool_writes_home=no         -> writing under HOME fails, uniformly for every tool,
                               instead of appearing to work and vanishing.
env_prefix=carried          -> the form the runner should use to pass the run's
                               context through.
NOTE

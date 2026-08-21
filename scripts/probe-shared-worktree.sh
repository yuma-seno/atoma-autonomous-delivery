#!/usr/bin/env bash
#
# probe-shared-worktree.sh — can two OS users share the work tree?
#
# #464 proposes running the shell tool server under a different uid, which the
# dumpable probe showed closes the environ hole outright. This asks the question
# that decides whether that is implementable at all: **the agent edits files**, so
# the shell user has to write the checkout `runner` owns, and `runner`'s git has to
# commit what the shell user wrote.
#
# The container answered this with `--user 1234:0` -- group 0, so the container
# wrote a tree the host owned. Same problem, without the container.
#
# The part that is easy to get wrong is not permission to CREATE a file. It is
# permission to MODIFY one the other user created: with a default umask a new file
# is `rw-r--r--` owned by its creator, so the other user can delete and replace it
# but cannot edit it in place -- and `filesystem__edit_file` edits in place. Two
# tools would see one file and only one could write it, which is worse than the
# split #464 exists to remove.
#
# Three mechanisms, weakest first, each on a FRESH tree so the previous round's
# arrangement cannot carry it:
#
#   1. nothing but a shared group                    -- the baseline
#   2. shared group + umask 002 + setgid directory   -- the classic arrangement
#   3. a default POSIX ACL                           -- independent of umask
#
# Why 3 matters even if 2 works: a shell command can call `umask` itself, and an
# arrangement a command inside the sandbox can undo is not an arrangement. Round 3
# is therefore run with umask 022 on purpose.
#
# Every answer prints as `RESULT <name>=<value>`. Nothing here tests Atoma.
set -uo pipefail

say() { printf '\n=== %s ===\n' "$1"; }
result() { printf 'RESULT %s=%s\n' "$1" "$2"; }
yn() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }

ME=$(id -un)
GROUP=$(id -gn)
TREE=/tmp/tree   # reassigned in round 6 to where a checkout really lives

say "who we are"
result runner_user "$ME"
result runner_primary_group "$GROUP"
sudo useradd -m -G "$GROUP" shelluser 2>/dev/null || sudo usermod -aG "$GROUP" shelluser
result shell_user_groups "$(id -nG shelluser 2>/dev/null || echo missing)"

make_tree() {
  sudo rm -rf "$TREE"; mkdir -p "$TREE"
  git -C "$TREE" init -q
  git -C "$TREE" config user.name probe
  git -C "$TREE" config user.email probe@example.com
  echo "original" > "$TREE/tracked.txt"
  git -C "$TREE" add tracked.txt
  git -C "$TREE" commit -qm initial
}

# One round: can each user create, and can each EDIT IN PLACE what the other made.
#
# The user is a parameter. It was hardcoded to `shelluser`, so round 6 -- whose
# whole point is the user that is NOT in the runner's group -- measured the wrong
# one and reported it under a label saying it had measured the right one.
probe_round() {
  local label="$1" umask_value="$2" who="${3:-shelluser}"

  result "${label}_dir_mode" "$(stat -L -c '%A %U:%G' "$TREE")"

  local created
  created=$(yn sudo -u "$who" sh -c "umask $umask_value; echo shell > $TREE/from-shell.txt")
  result "${label}_shell_creates" "$created"

  if [ "$created" = "yes" ]; then
    result "${label}_shell_file_mode" "$(stat -L -c '%A %U:%G' "$TREE/from-shell.txt")"
    # The one that decides it.
    result "${label}_runner_edits_shell_file" "$(yn sh -c "echo more >> $TREE/from-shell.txt")"
    result "${label}_runner_deletes_shell_file" "$(yn rm -f "$TREE/from-shell.txt")"
  else
    # Reported rather than skipped: `>>` on a missing path CREATES it, which would
    # have answered "yes" to a question that was never asked.
    result "${label}_runner_edits_shell_file" "n/a-nothing-was-created"
    result "${label}_runner_deletes_shell_file" "n/a-nothing-was-created"
  fi

  result "${label}_shell_edits_runner_file" "$(yn sudo -u "$who" sh -c "umask $umask_value; echo more >> $TREE/tracked.txt")"
}

# ── 1. a shared group and nothing else ───────────────────────────────────────
say "1. baseline — shared group, default permissions"
make_tree
probe_round baseline 022

# ── 2. shared group + umask 002 + setgid ─────────────────────────────────────
say "2. shared group + umask 002 + setgid directory"
make_tree
chmod -R g+w "$TREE"
find "$TREE" -type d -exec chmod g+s {} +
probe_round group 002

# ── 2b. the same arrangement, defeated from inside ───────────────────────────
say "2b. the same arrangement, with the shell choosing its own umask"
make_tree
chmod -R g+w "$TREE"
find "$TREE" -type d -exec chmod g+s {} +
probe_round group_umask_defeated 022

# ── 3. a default POSIX ACL, with umask 022 on purpose ────────────────────────
say "3. default POSIX ACL"
make_tree
result setfacl_available "$(yn command -v setfacl)"
sudo setfacl -R -m "u:shelluser:rwx" "$TREE" 2>/dev/null || echo "(setfacl -m failed)"
sudo setfacl -R -d -m "u:shelluser:rwx" "$TREE" 2>/dev/null || echo "(setfacl -d failed)"
sudo setfacl -R -d -m "u:$ME:rwx" "$TREE" 2>/dev/null || true
result acl_on_tree "$(getfacl -c "$TREE" 2>/dev/null | tr '\n' ' ' || echo unavailable)"
probe_round acl 022

# ── 4. can runner's git commit what the shell user wrote? ────────────────────
say "4. git, as runner, over a file the shell user created"
sudo -u shelluser sh -c "umask 022; echo from-shell > $TREE/committed.txt"
result git_status_sees_it "$(git -C "$TREE" status --porcelain | tr '\n' ' ')"
result git_no_ownership_complaint "$(yn git -C "$TREE" status)"
result git_add "$(yn git -C "$TREE" add -A)"
result git_commit "$(yn git -C "$TREE" commit -qm 'from the shell user')"
result git_committed "$(git -C "$TREE" show --name-only --format= HEAD | tr '\n' ' ')"

# ── 5. can the shell user run the server at all? ─────────────────────────────
#
# The server is a bun script, and `oven-sh/setup-bun` installs bun into the
# RUNNER's `$HOME`. So a different-uid shell server needs to execute a binary
# inside the home directory it is being isolated from.
#
# That is not a contradiction -- the threat was WRITING to `~/.bun/bin` (a fake
# `gh` on the credential-holding servers' PATH), and this needs only read and
# execute. But a design that depends on `$HOME`'s mode is fragile, so the
# alternative is measured beside it: install bun where the dumpable probe showed a
# different uid cannot write.
say "5. can the shell user execute bun"
BUN=$(command -v bun || echo "")
result bun_path "${BUN:-missing}"
result home_mode "$(stat -L -c '%A %U:%G' "$HOME")"
if [ -n "$BUN" ]; then
  result shell_user_runs_bun_from_home "$(sudo -u shelluser sh -c "$BUN --version >/dev/null 2>&1 && echo yes || echo no")"
  sudo install -m 0755 "$BUN" /usr/bin/bun-probe 2>/dev/null || echo "(install failed)"
  result shell_user_runs_bun_from_usr_bin "$(sudo -u shelluser sh -c "/usr/bin/bun-probe --version >/dev/null 2>&1 && echo yes || echo no")"
  result shell_user_writes_bun_in_usr_bin "$(sudo -u shelluser sh -c "printf x >> /usr/bin/bun-probe 2>/dev/null && echo yes || echo no")"
  sudo rm -f /usr/bin/bun-probe
fi

# ── 6. the arrangement as it would actually be deployed ──────────────────────
#
# Rounds 1-5 all ran with the shell user in the runner's GROUP, and with the tree
# in /tmp. Both were wrong, and each hid something.
#
# **The group would have opened the hole this is closing.** The runner's HOME is
# 750 with group `runner`, so a shell user in that group can read everything
# group-readable inside it -- including `~/.bun/bin`, which is on the
# credential-holding servers' PATH and is where #374 measured a fake `gh` being
# planted. Section 5's `shell_user_runs_bun_from_home=yes` came from the group,
# not from anything safe.
#
# **And /tmp is world-traversable, which the real work tree is not.** A checkout
# lives under `/home/runner/work/...`, so a user outside the group cannot even
# reach it -- ACL on the tree or not. The ACL therefore has to grant traversal on
# the path down to it, and `x` without `r` is exactly what an ACL can express and
# a mode cannot: reach the workspace, without being able to list HOME.
#
# So this round is the deployment: no shared group, the tree where a checkout
# really is, and traversal granted per-user.
say "6. no shared group, tree under HOME, traversal by ACL"
sudo useradd -m isolated 2>/dev/null || true
result isolated_groups "$(id -nG isolated 2>/dev/null || echo missing)"
result isolated_shares_group_with_runner \
  "$(id -nG isolated 2>/dev/null | tr ' ' '\n' | grep -qx "$GROUP" && echo yes || echo no)"

WORK="$HOME/work-probe"
sudo rm -rf "$WORK"; mkdir -p "$WORK"
TREE="$WORK/tree"
make_tree

# Before anything is granted: can it reach the tree at all?
result isolated_reaches_tree_before "$(sudo -u isolated sh -c "cat $TREE/tracked.txt >/dev/null 2>&1 && echo yes || echo no")"

# Traversal only -- x, no r -- on each directory down to the work tree.
sudo setfacl -m "u:isolated:x" "$HOME" "$WORK" 2>/dev/null || echo "(traversal setfacl failed)"
# And full access on the tree itself, for new files as well as existing ones.
sudo setfacl -R -m "u:isolated:rwx" "$TREE" 2>/dev/null || echo "(tree setfacl failed)"
sudo setfacl -R -d -m "u:isolated:rwx" "$TREE" 2>/dev/null || true
sudo setfacl -R -d -m "u:$ME:rwx" "$TREE" 2>/dev/null || true

result isolated_reaches_tree_after "$(sudo -u isolated sh -c "cat $TREE/tracked.txt >/dev/null 2>&1 && echo yes || echo no")"
# Traversal is not reading: it must still be unable to see what is in HOME.
result isolated_lists_home "$(sudo -u isolated sh -c "ls $HOME >/dev/null 2>&1 && echo yes || echo no")"

probe_round isolated 022 isolated

# ── 7. and the hole the group would have opened ──────────────────────────────
say "7. the bun directory, reached with and without the group"
BUNDIR=$(dirname "$(command -v bun || echo /nonexistent)")
result bun_dir "$BUNDIR"
result bun_dir_mode "$(stat -L -c '%A %U:%G' "$BUNDIR" 2>/dev/null || echo missing)"
result group_user_reads_bun_dir "$(sudo -u shelluser sh -c "ls $BUNDIR >/dev/null 2>&1 && echo yes || echo no")"
result group_user_plants_fake_gh "$(sudo -u shelluser sh -c "printf x > $BUNDIR/gh-probe 2>/dev/null && echo yes || echo no")"
rm -f "$BUNDIR/gh-probe" 2>/dev/null || true
result isolated_reads_bun_dir "$(sudo -u isolated sh -c "ls $BUNDIR >/dev/null 2>&1 && echo yes || echo no")"
result isolated_plants_fake_gh "$(sudo -u isolated sh -c "printf x > $BUNDIR/gh-probe 2>/dev/null && echo yes || echo no")"
rm -f "$BUNDIR/gh-probe" 2>/dev/null || true

# ── 8. what a traversable HOME exposes ──────────────────────────────────────
#
# Traversal on HOME is not optional -- the work tree is under it. So everything
# world-readable below HOME is readable by the shell user, and the question is
# whether any of it holds a credential.
#
# `gh` is the one that matters: our servers pass GH_TOKEN in the environment, but
# an adopter who ran `gh auth login` on a self-hosted runner has the token in
# `~/.config/gh/hosts.yml` instead. Asked rather than assumed, because the answer
# decides whether traversal needs to be narrowed to the work path alone.
say "8. credential-bearing files under a traversable HOME"
for f in .config/gh/hosts.yml .netrc .git-credentials .npmrc .docker/config.json .gitconfig; do
  target="$HOME/$f"
  if [ -e "$target" ]; then
    result "home_file_${f//[\/.]/_}" "$(stat -L -c '%A' "$target") readable_by_isolated=$(sudo -u isolated sh -c "cat '$target' >/dev/null 2>&1 && echo yes || echo no")"
  else
    result "home_file_${f//[\/.]/_}" "absent"
  fi
done
# And the one directory the whole arrangement needs to keep unreadable.
result isolated_reads_runner_ssh "$(sudo -u isolated sh -c "ls $HOME/.ssh >/dev/null 2>&1 && echo yes || echo no")"

say "reading the result"
cat <<'NOTE'
*_runner_edits_shell_file=no   -> that mechanism is NOT sufficient: both tools would
                                  see the file and only one could write it.
group_umask_defeated_*=no      -> umask 002 is not an arrangement, it is a request.
                                  A shell command can call `umask` and undo it.
acl_*=yes                      -> a default ACL carries it regardless of umask.
git_commit=yes                 -> runner can commit what the shell user wrote, so
                                  the deliverable path is unaffected.
shell_user_runs_bun_from_home  -> whether the design may depend on $HOME's mode.
isolated_reaches_tree_after=yes and
isolated_lists_home=no         -> the deployment works: reach the workspace without
                                  being able to see the home directory it is under.
group_user_plants_fake_gh      -> whether the group would have opened the hole #464
                                  is closing. `no` means ~/.bun/bin is not
                                  group-writable on this image, and the threat #374
                                  recorded was the shell running AS runner.
home_file_*=readable_by_isolated=yes for anything holding a credential
                               -> traversal on HOME is too wide and has to be
                                  narrowed to the work path alone.
*_from_usr_bin=yes and
*_writes_bun_in_usr_bin=no     -> the alternative works and cannot be tampered with,
                                  so $HOME's mode stops mattering.
NOTE

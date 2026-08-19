#!/usr/bin/env bun
/**
 * prepare_shell_confinement.ts — build the sandbox the `shell` tool server runs
 * in, before the agent starts.
 *
 * ## What this is for
 *
 * `shell` runs the project's builds and tests, which means it runs third-party
 * code: a dependency's `postinstall`, a `setup.py`, a `build.rs`. That code
 * executes with the tool server's own privileges, and until now those privileges
 * included reading `/proc/<pid>/environ` of every other tool server — each of
 * which holds exactly the credentials `tools.yaml` declared for it. Nothing about
 * that requires a compromised agent or an exploit:
 *
 *     cat > ~/.bun/bin/gh <<'X'
 *     #!/bin/sh
 *     env > /tmp/stolen
 *     exec /usr/bin/gh "$@"
 *     X
 *     chmod +x ~/.bun/bin/gh
 *
 * `~/.bun/bin` is on the servers' PATH and writable, so the next `gh` the
 * `github` server runs is that one. See #374 for the twenty-four measurements
 * that produced this arrangement, including the four designs it replaces.
 *
 * ## The shape
 *
 * Confine the one server that can READ arbitrary things, rather than the several
 * that HOLD credentials. One container instead of four, no per-server credential
 * plumbing, and a third party's `tools.secrets` is covered by the same act.
 *
 * The container sees the host filesystem read-only at the same paths, and may
 * write exactly two places: the work tree, and an overlay over `$HOME`.
 *
 * `$HOME` needs three things that ordinarily conflict. It must be READABLE
 * (rustup, nvm and pyenv keep the toolchain itself there, not just caches), it
 * must be WRITABLE (every ecosystem caches there), and it must have NO EFFECT on
 * the host (`~/.bun/bin` and `~/.cargo/bin` are on the PATH, and `~/.gitconfig`
 * makes host git execute what it is told). An overlay gives all three from one
 * mechanism, with no list of blocked filenames to keep.
 *
 * Usage:
 *   prepare_shell_confinement.ts --out "$RUNNER_TEMP/shell-sandbox"
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { defineScript } from "./lib/script-ref.ts";

export interface PrepareShellConfinementArgs {
  /** Directory to write the generated mount sources into. Must be outside the work tree. */
  out: string;
}

export const ref = defineScript<PrepareShellConfinementArgs>(import.meta.url);

/**
 * Where the overlay lives.
 *
 * NOT under `$RUNNER_TEMP`, which sits inside `$HOME`: overlayfs refuses an
 * upperdir nested inside its own lowerdir. `/mnt` is the runner's large scratch
 * disk and is outside the home directory.
 */
const OVERLAY_ROOT = "/mnt/atoma-shell-overlay";

/**
 * The user the container runs as, and the one the nested container runtime runs
 * as.
 *
 * Not 0. Rootless podman maps container uid 0 to the host user, which would put
 * the container's environment back within reach of everything else running as
 * that user — the exact reading this whole arrangement closes. Any other id maps
 * into the subuid range instead, and `/proc/<pid>/environ` becomes unreadable
 * from the host.
 *
 * Group 0, though, which rootless podman maps to the host user's primary group.
 * That is what lets the container write a work tree the host owns, once the tree
 * is group-writable.
 *
 * And not 1000 either, which was the first choice and collided. The runner image
 * already has a `packer` account there, and the passwd below is the HOST's plus
 * one appended line — so the earlier entry wins every lookup. podman resolved uid
 * 1000 to `packer`, found no subuid range for that name, and quietly fell back to
 * a single mapping:
 *
 *   cannot find UID/GID for user packer: no subuid ranges found for user "packer"
 *
 * A warning inside a tool call nobody was reading. `assertIdentityIsFree` below
 * turns the next such collision into a failed run instead.
 */
const CONTAINER_UID = 1234;
const CONTAINER_GID = 0;
const CONTAINER_USER_NAME = "atoma-builder";

/**
 * Subordinate ids for the nested runtime, inside what the outer mapping allows.
 *
 * "Inside" is the whole content of this constant, and the first version got it
 * wrong. A user namespace can only map ids that exist in its PARENT, and the
 * parent here is this container, whose own map was measured from inside it:
 *
 *   $ cat /proc/self/uid_map
 *            0       1001          1
 *            1     165536      65536
 *
 * So the ids that exist in here run 0..65536, and a range starting at 100000 names
 * nothing. `newuidmap` was being asked to map onto ids the kernel has no
 * translation for, which it refuses -- and it refuses with the same EPERM as a
 * missing privilege, so the two failures are indistinguishable from the message.
 *
 * 10000..60000 fits, and steps around CONTAINER_UID rather than through it.
 */
const SUBID_RANGE = "10000:50000";

/**
 * `newuidmap` and `newgidmap`, as one script that is deliberately NOT setuid.
 *
 * The setuid bit is what broke this, not what was missing. Measured on #426, from
 * inside the container:
 *
 *   CapInh: 00000000000000c0   CapPrm: 00000000000000c0   CapEff: 00000000000000c0
 *
 * The container already holds CAP_SETUID and CAP_SETGID *effectively* -- podman
 * gives a non-root `--user` the added capabilities as AMBIENT ones, and ambient
 * capabilities are effective. The same run wrote podman's own two-line mapping to a
 * fresh namespace by hand and it succeeded:
 *
 *   0 1234 1
 *   1 10000 50000
 *
 * So the mapping was never the problem. Executing a setuid binary CLEARS the
 * ambient set, and inside a non-initial user namespace a setuid-root file confers
 * no capabilities to replace them -- so the host's `newuidmap`, and the owned copy
 * v0.1.53 put on the PATH, both arrived as euid 0 with nothing to be root with:
 *
 *   newuidmap: write to uid_map failed: Operation not permitted
 *
 * A plain executable keeps the ambient set across exec and simply writes the file.
 * It grants nothing the calling process did not already have -- the agent can write
 * such a map itself, with or without this script. What it does is let podman, which
 * always delegates to these two names, reach the privilege it is already running
 * with.
 *
 * Both names are one file, chosen by how it was invoked. The whole map has to reach
 * the kernel in a single write, which is why the lines are collected first.
 */
const ID_MAP_SHIM = `#!/bin/sh
# Generated by prepare_shell_confinement.ts. NOT setuid, on purpose: see #426.
set -e
case "$0" in
  *gidmap) map=gid_map ;;
  *) map=uid_map ;;
esac
pid="$1"
shift
lines=""
while [ "$#" -ge 3 ]; do
  lines="$lines$1 $2 $3
"
  shift 3
done
if [ -z "$lines" ]; then
  echo "usage: $0 PID [inside outside count]..." >&2
  exit 1
fi
printf %s "$lines" > "/proc/$pid/$map"
`;

function main(): void {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { out: { type: "string" } } });
  if (!values.out) {
    console.error("usage: prepare_shell_confinement.ts --out DIR");
    process.exit(2);
  }
  const out = values.out;
  mkdirSync(out, { recursive: true });

  // `/etc` is mounted from the host read-only, so these are laid over it as
  // deeper mounts rather than edited in place.
  const hostPasswd = readHostPasswd();
  assertIdentityIsFree(hostPasswd);
  const passwd =
    `${hostPasswd}${CONTAINER_USER_NAME}:x:${CONTAINER_UID}:${CONTAINER_GID}::/home/runner:/bin/bash\n`;
  writeFileSync(join(out, "passwd"), passwd);
  writeFileSync(join(out, "subuid"), `${CONTAINER_USER_NAME}:${SUBID_RANGE}\n`);
  writeFileSync(join(out, "subgid"), `${CONTAINER_USER_NAME}:${SUBID_RANGE}\n`);

  // Podman sets net.ipv4.ping_group_range by default and cannot write /proc/sys
  // from inside a container, which fails every nested container it starts.
  writeFileSync(join(out, "containers.conf"), "[containers]\ndefault_sysctls = []\n");

  // Storage for the nested runtime, and the one option the single-mapping case
  // needs.
  //
  // With only one id available inside, extracting an image cannot restore a file
  // owned by anyone else, and the extraction fails rather than approximating. That
  // is the right default for a real installation and the wrong one here, where the
  // alternative is no nested containers at all. Measured on #408: podman announces
  // the mode it is in --
  //
  //   Using rootless single mapping into the namespace. This might break some
  //   images.
  //
  // -- and what breaks is an image with a non-root USER, not images generally.
  //
  // Both drivers, because which one podman picks depends on what the kernel lets it
  // mount and the option is per-driver. No `driver =` of our own: podman's own
  // detection is better informed than a guess written here.
  writeFileSync(
    join(out, "storage.conf"),
    '[storage.options.overlay]\nignore_chown_errors = "true"\n\n' +
      '[storage.options.vfs]\nignore_chown_errors = "true"\n',
  );

  writeFileSync(join(out, "newidmap"), ID_MAP_SHIM);
  chmodSync(join(out, "newidmap"), 0o755);

  for (const name of ["passwd", "subuid", "subgid", "containers.conf", "storage.conf"]) {
    chmodSync(join(out, name), 0o644);
  }

  console.error(`shell confinement: wrote mount sources to ${out}`);
  console.error(`shell confinement: overlay root is ${OVERLAY_ROOT}`);
}

/**
 * Refuse to proceed if the host already uses this uid or this name.
 *
 * `tools.yaml` names the uid, so it cannot be chosen here at run time. What can be
 * done is stop rather than hand the container somebody else's identity — which is
 * exactly what uid 1000 did, and it surfaced only as a warning in a tool result.
 */
function assertIdentityIsFree(hostPasswd: string): void {
  for (const line of hostPasswd.split("\n")) {
    const [name, , uid] = line.split(":");
    if (name === CONTAINER_USER_NAME) {
      throw new Error(
        `the host already has an account named ${CONTAINER_USER_NAME}. ` +
          "Pick another name in prepare_shell_confinement.ts.",
      );
    }
    if (uid === String(CONTAINER_UID)) {
      throw new Error(
        `the host already uses uid ${CONTAINER_UID} (${name}), so the container would run as ` +
          "that account and podman would find no subuid range for it. Pick another uid here " +
          "AND in tools.yaml's --user.",
      );
    }
  }
}

/** The host's own passwd, so every real account still resolves inside. */
function readHostPasswd(): string {
  const result = Bun.spawnSync({ cmd: ["getent", "passwd"], stdout: "pipe" });
  const text = result.stdout?.toString("utf8") ?? "";
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

export {
  assertIdentityIsFree,
  CONTAINER_GID,
  CONTAINER_UID,
  CONTAINER_USER_NAME,
  ID_MAP_SHIM,
  OVERLAY_ROOT,
  SUBID_RANGE,
};

if (import.meta.main) main();

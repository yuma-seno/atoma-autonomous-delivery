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
 */
const CONTAINER_USER = "1000:0";
const CONTAINER_USER_NAME = "builder";

/** Subordinate ids for the nested runtime, inside what the outer mapping allows. */
const SUBID_RANGE = "100000:60000";

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
  const passwd = `${readHostPasswd()}${CONTAINER_USER_NAME}:x:1000:0::/home/runner:/bin/bash\n`;
  writeFileSync(join(out, "passwd"), passwd);
  writeFileSync(join(out, "subuid"), `${CONTAINER_USER_NAME}:${SUBID_RANGE}\n`);
  writeFileSync(join(out, "subgid"), `${CONTAINER_USER_NAME}:${SUBID_RANGE}\n`);

  // Podman sets net.ipv4.ping_group_range by default and cannot write /proc/sys
  // from inside a container, which fails every nested container it starts.
  writeFileSync(join(out, "containers.conf"), "[containers]\ndefault_sysctls = []\n");

  for (const name of ["passwd", "subuid", "subgid", "containers.conf"]) {
    chmodSync(join(out, name), 0o644);
  }

  console.error(`shell confinement: wrote mount sources to ${out}`);
  console.error(`shell confinement: overlay root is ${OVERLAY_ROOT}`);
}

/** The host's own passwd, so every real account still resolves inside. */
function readHostPasswd(): string {
  const result = Bun.spawnSync({ cmd: ["getent", "passwd"], stdout: "pipe" });
  const text = result.stdout?.toString("utf8") ?? "";
  return text.endsWith("\n") || text === "" ? text : `${text}\n`;
}

export { CONTAINER_USER, CONTAINER_USER_NAME, OVERLAY_ROOT };

if (import.meta.main) main();

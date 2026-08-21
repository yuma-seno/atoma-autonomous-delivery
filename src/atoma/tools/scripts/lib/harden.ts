/**
 * harden.ts — what a tool server that holds a credential does to itself at startup.
 *
 * Two things, and both exist because every tool server now runs as ONE dedicated
 * OS user (#464). That arrangement is what gives every tool the same environment,
 * and it is also what makes these two necessary: same user means the shell server
 * is a peer, not a stranger.
 *
 * ## 1. Become unreadable
 *
 * `/proc/<pid>/environ` is readable between processes of one user. Measured on
 * `ubuntu-latest`: a peer process reads the value out of a holder's environment
 * block, plainly. `prctl(PR_SET_DUMPABLE, 0)` makes the kernel own that entry
 * root and refuse the read — measured, with the credential still in the
 * environment block and still readable BY THIS PROCESS. It locks the door from
 * outside, not the value.
 *
 * atoma does this for itself, which is why the provider API key was never at
 * risk. It does not carry to a child: the flag is reset on `execve`, also
 * measured, so it cannot be set for a server by whatever launches it. The server
 * has to call it, here.
 *
 * The one cost: no debugger, `strace` or `perf` attaches to this process as the
 * same user any more. That needs `sudo`, and the user these run as does not have
 * it — so debugging a server means running it by hand.
 *
 * ## 2. Narrow PATH
 *
 * See `domain/tool-hardening.ts`. Briefly: three directories on the runner's PATH
 * are world-writable, so a peer can put a file called `gh` in one and the server
 * that looks `gh` up hands it the token. Nothing is read; the credential is
 * delivered.
 *
 * ## What this does not close
 *
 * A child process. `gh` is a statically linked Go binary, so `LD_PRELOAD` cannot
 * make it non-dumpable, and the flag does not survive its `execve` either — so
 * while `gh` runs, GH_TOKEN is in a readable environment block. That exposure is
 * accepted rather than fixed: GH_TOKEN expires with the job, the agent can
 * already use it through the github tools, and `actions/checkout` leaves the same
 * value in `.git/config` inside the work tree.
 *
 * A third-party server. It will not call this, and nothing can call it on its
 * behalf. See docs/customization.md, "What a tool can and cannot be protected
 * from".
 */
import { statSync } from "node:fs";
import { classifyPathEntries, pathWithoutWorldWritable } from "../../../../domain/tool-hardening.ts";

const PR_SET_DUMPABLE = 4;
const PR_GET_DUMPABLE = 3;

/**
 * What a PATH entry is, as far as this process can tell.
 *
 * Three answers rather than two, because the first real run of this reported four
 * directories as "writable" that it had only failed to stat -- `node_modules/.bin`
 * paths that do not exist, and `/home/runner/.local/bin`, whose parent this user
 * cannot traverse. Dropping those is harmless: a directory this process cannot
 * inspect is one it cannot execute from either. Calling them writable is not.
 *
 * The distinction is worth the third case because this produces a security-shaped
 * log line, and a reader will take it at face value.
 */
function inspect(directory: string): "writable" | "safe" | "unreadable" {
  try {
    return (statSync(directory).mode & 0o002) !== 0 ? "writable" : "safe";
  } catch {
    return "unreadable";
  }
}

/**
 * Make this process unreadable to its peers and remove writable directories from
 * its PATH.
 *
 * Failures are logged and tolerated. Neither of these is what protects the
 * provider API key — atoma holds that and hardens itself — so a server that
 * cannot harden should still start and do its job rather than take the run down.
 * The log line is what makes the difference visible.
 */
export function hardenCredentialHolder(log: (message: string) => void): void {
  try {
    // Imported here rather than at the top: `bun:ffi` is a Bun builtin, and a
    // server bundled for another runtime should fail on this line with a message
    // about FFI rather than on its first import.
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const { symbols } = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n);
    const dumpable = symbols.prctl(PR_GET_DUMPABLE, 0n, 0n, 0n, 0n);
    if (dumpable === 0) log("this process is now unreadable to its peers");
    else log(`WARN could not become unreadable: PR_GET_DUMPABLE reports ${dumpable}`);
  } catch (error) {
    log(`WARN could not become unreadable: ${(error as Error).message}`);
  }

  const before = process.env.PATH ?? "";
  const { writable, unreadable } = classifyPathEntries(before, inspect);
  if (writable.length === 0 && unreadable.length === 0) return;

  const after = pathWithoutWorldWritable(before, (entry) => inspect(entry) !== "safe");
  // Never leave this server without a PATH. `isWorldWritable` answers "yes" for a
  // directory it cannot stat, which is right for one entry and catastrophic for
  // every entry: an empty PATH makes every `gh` and `git` call in this process
  // fail with ENOENT, and the only sign would be one line in a log. Dropping
  // everything is not a narrowing, it is a broken stat.
  if (after === "") {
    log(`WARN every PATH entry looked writable, which cannot be right; leaving PATH alone`);
    return;
  }

  process.env.PATH = after;
  // Reported separately. The first list is the one that matters -- a peer could
  // have put a binary there and this process would have run it. The second is
  // housekeeping, and saying so keeps the first line meaningful.
  if (writable.length > 0) log(`removed WRITABLE directories from PATH: ${writable.join(", ")}`);
  if (unreadable.length > 0) log(`also removed ${unreadable.length} PATH entries this process cannot inspect`);
}

/**
 * tool-hardening.ts — which directories a credential-holding server must not
 * look for a program in.
 *
 * ## Why a tool server narrows its own PATH
 *
 * Every tool server runs as one dedicated OS user with no sudo (#464). That user
 * cannot read another server's environment block, because the servers holding a
 * credential make themselves non-dumpable — but it CAN write a world-writable
 * directory, and three of them are on the runner's PATH. Measured on
 * `ubuntu-latest`, all `drwxrwxrwx`:
 *
 *   /opt/pipx_bin
 *   /usr/local/.ghcup/bin
 *   /usr/local/bin
 *
 * So a command run through the shell can drop a file called `gh` into one of
 * them, and the `github` server — which holds GH_TOKEN and looks up `gh` on PATH
 * — executes it and hands it the token as its own environment. Nothing is read
 * out of anywhere; the credential is delivered.
 *
 * `/usr/bin` and `/bin` are not writable by that user, and `gh` and `git` both
 * live in `/usr/bin`, so a PATH without the writable entries still finds
 * everything these servers run.
 *
 * ## Dropping rather than replacing
 *
 * The obvious version of this is `PATH=/usr/bin:/bin`. It is also the version
 * that breaks a project whose `environment.setup_commands` put a tool somewhere
 * else: the entry disappears and the failure is "command not found" in a server,
 * far from the cause. Removing only the entries that are writable keeps
 * everything that works, working.
 */

/** Whether a directory can be written by anyone — the property that makes it unsafe here. */
export type IsWorldWritable = (directory: string) => boolean;

/**
 * `PATH` with every world-writable entry removed, in order.
 *
 * Empty entries are dropped too. An empty element in PATH means the current
 * directory, and the current directory of a tool server is the work tree — which
 * the agent writes, so it is the most writable place there is.
 */
export function pathWithoutWorldWritable(path: string, isWorldWritable: IsWorldWritable): string {
  return path
    .split(":")
    .filter((entry) => entry !== "" && entry !== "." && !isWorldWritable(entry))
    .join(":");
}

/**
 * The entries removed, for the log line that says so.
 *
 * Reported rather than silent: a server whose PATH quietly lost an entry is a
 * server that fails later with "command not found" and nothing connecting the
 * two.
 */
export function worldWritableEntries(path: string, isWorldWritable: IsWorldWritable): string[] {
  return path.split(":").filter((entry) => entry !== "" && (entry === "." || isWorldWritable(entry)));
}

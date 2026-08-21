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
 * What each PATH entry is, split into the two reasons an entry is dropped.
 *
 * Two lists rather than one, because the first real run of this logged four
 * directories as "writable" that it had only failed to stat. Both get dropped --
 * a directory a process cannot inspect is one it cannot execute from -- but only
 * the first is a security finding, and a log line that conflates them makes the
 * finding unreadable.
 */
export function classifyPathEntries(
  path: string,
  inspect: (entry: string) => "writable" | "safe" | "unreadable",
): { writable: string[]; unreadable: string[] } {
  const writable: string[] = [];
  const unreadable: string[] = [];
  for (const entry of path.split(":")) {
    if (entry === "" || entry === ".") {
      // An empty element means the current directory, and a tool server sits in
      // the work tree -- which the agent writes. Counted as writable because that
      // is what it is.
      writable.push(entry === "" ? "(empty, meaning the current directory)" : entry);
      continue;
    }
    const verdict = inspect(entry);
    if (verdict === "writable") writable.push(entry);
    else if (verdict === "unreadable") unreadable.push(entry);
  }
  return { writable, unreadable };
}

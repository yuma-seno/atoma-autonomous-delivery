/**
 * notify.ts — Resolve who to notify (a GitHub login) for a given issue or
 * PR. The one canonical implementation, used directly (no more subprocess
 * spawn) by every caller: mcp/github.ts, concludeIssue,
 * the aggregation gate (lib/aggregation.ts), and
 * src/scripts/resolve_notify.ts's thin CLI wrapper (kept because
 * atoma-runner.wac.ts invokes it as a workflow step, via `scriptCommand`).
 *
 * # This is the fallback, not the rule
 *
 * Who gets notified is decided where a run starts, and every live path already
 * answers the question this module answers badly. A run started by a comment
 * notifies whoever typed it (`comment.user.login`); a run started by an issue
 * notifies whoever opened it (`sender.login`); a run one agent hands to another
 * carries the same login onward, so a chain notifies whoever began it. That is the
 * rule -- **the person who asked for this run**, not the person who owns the thread.
 *
 * This module exists for when that plumbing delivers nothing: a caller that forgot
 * to pass it, a dispatch path added later, a body whose tag was lost. The runner
 * calls it only when `inputs.notify` arrives empty. Read what follows as recovery,
 * and do not extend it as though it were the policy -- if a new trigger needs a
 * notify, it decides one at the trigger, where it knows who acted.
 *
 * # What recovery does
 *
 * Looks for an `<!-- atoma:notify=LOGIN -->` tag in the body -- embedded by
 * mcp/github.ts at creation time, carrying the requester the creating run knew.
 *
 * Falls back to the issue/PR's own author when no tag is present and the author is
 * a human. If neither is available, walks up the `atoma:parent`/`atoma:parent-issue`
 * chain and retries on the parent. Measured over all 255 issues in this repository,
 * no issue would need that walk: every one resolves by its own tag or its own
 * author. It is kept for a repository whose history is not this one.
 *
 * Last, the repository owner, so that a failure reaches somebody rather than
 * nobody. That is a weaker claim than the others -- the owner did not ask for this
 * run and may not know what it was -- so the comment that mentions them says why
 * they are being told.
 *
 * Never throws for missing data -- callers treat an empty result as
 * "nobody to notify".
 */
import { gh } from "./gh.ts";
import { NOTIFY_TAG, readAnyParentTag } from "./tags.ts";

function log(message: string): void {
  console.error(`[atoma-notify] ${message}`);
}

const MAX_HOPS = 10;

interface IssueLookup {
  body?: string;
  login?: string;
  type?: string;
}

/**
 * The repository's owner, or `""` if it cannot be read.
 *
 * The last resort, and the one place here that names somebody who did not ask for
 * the run. It is still better than the alternative: before this, a run whose notify
 * plumbing delivered nothing ended with a comment that mentioned no one, so a
 * failure sat on an issue until somebody happened to look. Nobody being told is not
 * a safer default than the wrong person being told -- it is the same failure with
 * no one able to notice it.
 *
 * An organisation-owned repository resolves to the organisation, which GitHub does
 * not notify. That is a worse answer than a person and a better one than silence,
 * and it is visible in the comment either way.
 */
function repositoryOwner(repo: string): string {
  const owner = repo.split("/")[0]?.trim() ?? "";
  if (!owner) log(`WARN could not read an owner out of ${JSON.stringify(repo)}; nobody will be mentioned`);
  return owner;
}

/**
 * Read the fields a mention is resolved from, or `{}` if they cannot be read.
 *
 * Not throwing is deliberate — this module's stance is that a dispatch is never
 * failed over a mention. But a failure here is indistinguishable to
 * `resolveNotify` from an issue that genuinely has no tag, no login and no
 * parent, and the visible result is a completion or escalation comment that
 * mentions nobody: the person who asked for the work is simply never pinged.
 *
 * So it says so. Every other I/O module here logs a WARN on this class of
 * failure; this was the one that produced no trace at all, which made a silent
 * degradation impossible to find afterwards.
 */
function fetchIssueLookup(repo: string, number: number): IssueLookup {
  const { code, stderr, stdout } = gh(
    "api", `repos/${repo}/issues/${number}`,
    "--jq", "{body: .body, login: .user.login, type: .user.type}",
  );
  if (code !== 0 || !stdout.trim()) {
    log(`WARN could not read issue #${number} to resolve a mention: ${stderr.trim() || `gh exited ${code}`}`);
    return {};
  }
  try {
    return JSON.parse(stdout) as IssueLookup;
  } catch {
    log(`WARN issue #${number} lookup was not valid JSON; no mention will be resolved from it`);
    return {};
  }
}

export function resolveNotify(repo: string, number: number): string {
  const visited = new Set<number>();
  let current = number;
  for (let i = 0; i < MAX_HOPS; i++) {
    if (visited.has(current)) break; // cycle guard
    visited.add(current);

    const d = fetchIssueLookup(repo, current);
    const body = d.body ?? "";

    const tagged = NOTIFY_TAG.read(body);
    if (tagged) return tagged;

    if ((d.type ?? "").toLowerCase() === "user" && d.login) {
      return d.login;
    }

    const parent = readAnyParentTag(body);
    if (parent === undefined) break;
    current = parent;
  }
  // Nothing in the thread said who to tell, so the owner is told. See
  // `repositoryOwner` for why that beats telling nobody.
  const owner = repositoryOwner(repo);
  if (owner) log(`no requester found for #${number}; falling back to the repository owner @${owner}`);
  return owner;
}

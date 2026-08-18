/**
 * notify.ts — Resolve who to notify (a GitHub login) for a given issue or
 * PR. The one canonical implementation, used directly (no more subprocess
 * spawn) by every caller: mcp/github.ts, concludeIssue,
 * the aggregation gate (lib/aggregation.ts), and
 * src/scripts/resolve_notify.ts's thin CLI wrapper (kept because
 * atoma-runner.wac.ts invokes it as a workflow step, via `scriptCommand`).
 *
 * Looks for an `<!-- atoma:notify=LOGIN -->` tag in the body -- embedded by
 * mcp/github.ts when the agent that created the issue/PR knew who the
 * original human requester was.
 *
 * Falls back to the issue/PR's own author when no tag is present and the
 * author is a human. If neither is available, walks up the
 * `atoma:parent`/`atoma:parent-issue` chain and retries on the parent,
 * since every sub-issue/PR is ultimately rooted in an issue a human opened
 * directly. Gives up after MAX_HOPS to guard against cycles.
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
  return "";
}

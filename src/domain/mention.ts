/**
 * mention.ts — an agent's `@name` reaches a person, so it is checked first.
 *
 * # What goes wrong without this
 *
 * An agent writes `@torvalds` and GitHub notifies that person. No malice is
 * required: a name read out of a commit log, a dependency's README, or a stack
 * trace is a name it can repeat. And **there is no path by which anyone here finds
 * out** — the notification is visible only to whoever received it, and this side's
 * log says "posted a comment".
 *
 * # What this does
 *
 * A mention whose target is neither a repository participant nor somebody who has
 * commented on this thread is wrapped in backticks: `@name` stays legible and
 * notifies nobody. Escaping rather than deleting, because deleting loses who the
 * agent was trying to reach, which is usually the interesting part.
 *
 * # Fail closed, and why that is the cheap direction
 *
 * When the participant list cannot be read, everything is escaped. The two
 * mistakes are not the same size:
 *
 *   - escaping a name that was fine: a person is not pinged, and the text still
 *     names them, in a comment they can see
 *   - not escaping one that was not: a stranger is notified, and nobody here knows
 *
 * # Where it does not apply
 *
 * Inside a fenced code block or an inline code span. GitHub does not notify from
 * either, so there is nothing to prevent -- and adding backticks inside a code
 * block would change code somebody is meant to read. That is the one case where
 * doing the safe-looking thing is the destructive one.
 */

/**
 * A GitHub login as GitHub itself allows one: alphanumerics and single hyphens,
 * up to 39 characters, not starting or ending with a hyphen.
 *
 * The leading group keeps `foo@example.com` and `path/@scope` out of it -- an
 * email address is not a mention, and neither is a scoped package. The trailing
 * `(?!\/)` does the same for `@org/team`, which GitHub treats as a team.
 */
const MENTION = /(^|[^\w@/-])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\b(?!\/)/g;

/** A fenced code block, or an inline code span, in that order of greed. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

export interface MentionCheck {
  /** The text, with unknown mentions wrapped in backticks. */
  text: string;
  /** Which logins were escaped, in the order they appeared, without repeats. */
  escaped: string[];
}

/**
 * Wrap every mention that is not in `known`, leaving code alone.
 *
 * `known` is compared case-insensitively, because GitHub logins are.
 */
export function escapeUnknownMentions(text: string, known: Iterable<string>): MentionCheck {
  const allowed = new Set([...known].map((login) => login.trim().toLowerCase()).filter(Boolean));
  const escaped: string[] = [];

  const transform = (segment: string): string =>
    segment.replace(MENTION, (whole, before: string, login: string) => {
      if (allowed.has(login.toLowerCase())) return whole;
      if (!escaped.includes(login)) escaped.push(login);
      return `${before}\`@${login}\``;
    });

  // Walk the code spans and transform only what lies between them.
  let out = "";
  let last = 0;
  CODE.lastIndex = 0;
  for (const match of text.matchAll(CODE)) {
    const at = match.index ?? 0;
    out += transform(text.slice(last, at));
    out += match[0];
    last = at + match[0].length;
  }
  out += transform(text.slice(last));

  return { text: out, escaped };
}

/**
 * The line added to a comment when something was escaped, or `undefined`.
 *
 * Addressed to the person who will read the thread, not to the agent: by the time
 * this is written the run has ended, and what matters is that somebody can see a
 * mention was intended and did not happen.
 */
export function escapedMentionNotice(escaped: readonly string[]): string | undefined {
  if (escaped.length === 0) return undefined;
  const names = escaped.map((login) => `\`@${login}\``).join(", ");
  return (
    `> [!NOTE]\n` +
    `> ${names} ${escaped.length === 1 ? "was" : "were"} written as ${escaped.length === 1 ? "a mention" : "mentions"} ` +
    `and had the notification removed: this run could not confirm ${escaped.length === 1 ? "that account" : "those accounts"} ` +
    `as a participant in this repository or this thread. Nobody was notified. If the mention was meant, mention them yourself.`
  );
}

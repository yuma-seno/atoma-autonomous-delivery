/**
 * unattended-pull-request.ts — whether a new pull request has anyone coming for it.
 *
 * #486 removed the `auto_triggers` entries that started a reviewer when a pull
 * request was opened, synchronised or marked ready. Nothing starts unless someone
 * asks, which is the rule the whole system now runs on -- an agent names the
 * reviewer, or a person types `/reviewer`.
 *
 * That rule has one failure mode, and it is silent: an agent opens a pull request,
 * names no reviewer, mentions nobody, and the pull request sits. CI runs, the check
 * goes green, and the work waits for someone who was never told. Under the old
 * triggers this could not happen; making asking explicit made forgetting possible.
 *
 * So the machinery checks, mechanically, and says so. Not by guessing intent -- by
 * asking whether either of the two things that would bring a person or an agent is
 * present.
 */

/** What a new pull request was given to reach someone. */
export interface Attendance {
  /** The agent the caller named to review it, or "" for none. */
  reviewer: string;
  /** The pull request body, which may mention a person. */
  body: string;
}

/**
 * Whether anybody was asked to look at this.
 *
 * Two ways, and either is enough:
 *
 *   - an agent was named, so one will be dispatched when CI passes
 *   - a person was mentioned in the body, so they were told
 *
 * A mention is `@` followed by a GitHub login. Deliberately loose: this decides
 * whether to add a notice, and a false positive costs a notice nobody needed while
 * a false negative leaves work unattended. Whether the mention reaches a real,
 * relevant person is a separate question, and a real one -- see #509.
 */
export function isAttended(attendance: Attendance): boolean {
  if (attendance.reviewer.trim() !== "") return true;
  return mentionsSomeone(attendance.body);
}

/**
 * Whether the text mentions a GitHub login.
 *
 * `@` at a word boundary, then GitHub's own login shape: alphanumerics and single
 * hyphens, 1-39 characters. The boundary before is what keeps an email address out
 * -- `someone@example.com` has a word character in front of the `@`.
 *
 * The lookahead after keeps a SCOPED PACKAGE out, which is the case that made this
 * fail when it was written: `bun add @huggingface/transformers` matched, because
 * `@huggingface` is exactly the shape of a login. A trailing `/` is what tells them
 * apart, and this repository's own pull request bodies contain the package form.
 *
 * A fenced code block is not excluded. A pull request body that mentions a person
 * only inside an example is unusual enough, and reading a notice nobody needed
 * costs less than leaving work unattended.
 */
export function mentionsSomeone(text: string): boolean {
  return /(^|[^\w@/-])@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\b(?!\/)/.test(text);
}

/**
 * The comment left on an unattended pull request.
 *
 * Addressed to the person the run resolves to, and says what to do in one line.
 * Names the pull request rather than describing it, because this lands on the pull
 * request itself and a summary would just repeat what is above it.
 *
 * `notify` may be empty -- `resolveNotify` returns "" when it can read no tag, no
 * human author and no parent. The comment is still posted: an unattended pull
 * request with nobody to name is worse than one with somebody, not better, and a
 * comment on the pull request is at least visible to whoever opens it.
 */
export function unattendedNotice(notify: string, agent: string): string {
  const mention = notify.trim() ? `@${notify.trim()} ` : "";
  return (
    `${mention}This pull request was opened by \`${agent}\` with no reviewer named and nobody mentioned, ` +
    `so nothing is scheduled to look at it. CI still runs and its result stands. ` +
    `Comment \`/reviewer\` to have it reviewed, or take it from here.`
  );
}

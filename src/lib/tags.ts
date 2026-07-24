/**
 * tags.ts — canonical encode/decode for every `<!-- atoma:xxx=... -->`
 * HTML-comment marker Atoma embeds in issue/PR bodies and comments to carry
 * state across otherwise-stateless GitHub Actions workflow runs.
 *
 * Before this module existed, each tag had its own hand-rolled regex,
 * independently redefined (with occasionally inconsistent formatting -- a
 * mix of `=`/`:` separators, optional/required leading `#`) in every file
 * that needed to read or write it. This is now the ONE place each tag's
 * wire format is defined; every reader/writer imports from here instead of
 * re-deriving its own regex.
 *
 * Two tags (`parent`, `parent-issue`) keep a leading `#`-or-not quirk that
 * predates this module and is preserved deliberately -- `parent` has always
 * been written as `#N` (both in already-created sub-issues' bodies and in
 * `check_open_siblings.ts`'s GitHub search query string), `parent-issue`
 * always without. Changing either now would silently stop recognizing
 * already-existing tags on issues/PRs created before this module existed.
 */

export interface AtomaTag<T> {
  /** Render this tag's HTML-comment form, ready to prepend/embed in a body or comment. */
  write(value: T): string;
  /** Extract this tag's value from anywhere in `text`, or undefined if absent. */
  read(text: string): T | undefined;
  /** True if `text` contains this tag at all, regardless of its value. */
  has(text: string): boolean;
}

function makeTag<T>(key: string, valuePattern: string, parse: (raw: string) => T, render: (value: T) => string): AtomaTag<T> {
  const re = new RegExp(`<!--\\s*atoma:${key}=(${valuePattern})\\s*-->`);
  return {
    write: (value) => `<!-- atoma:${key}=${render(value)} -->`,
    read: (text) => {
      const m = re.exec(text);
      return m ? parse(m[1]!) : undefined;
    },
    has: (text) => re.test(text),
  };
}

/** Numeric-valued tag, e.g. `atoma:foo=42`. `hashPrefix` controls whether a literal `#` is written/required before the number (see module doc comment for why `parent` and `parent-issue` differ here). */
function numericTag(key: string, hashPrefix: boolean): AtomaTag<number> {
  // Read tolerates an optional "#" regardless of `hashPrefix`, so a tag
  // written under a future format change (or by an older/newer version of
  // this module) is still recognized on read.
  return makeTag(key, "#?\\d+", (raw) => Number(raw.replace(/^#/, "")), (value) => `${hashPrefix ? "#" : ""}${value}`);
}

/** String-valued tag, e.g. `atoma:foo=bar-baz`. */
function stringTag(key: string, valuePattern: string): AtomaTag<string> {
  return makeTag(key, valuePattern, (raw) => raw, (value) => value);
}

/** Sub-issue -> orchestrator parent ISSUE link (set via `github__create_issue`'s `sub_issue: true`). Written as `#N` -- see module doc comment. */
export const PARENT_TAG = numericTag("parent", true);
/** PR -> the issue it closes/was created to address (set via `github__create_pr`). Written as plain `N`, no `#`. */
export const PARENT_ISSUE_TAG = numericTag("parent-issue", false);
/** Who to `@mention` on completion/escalation. */
export const NOTIFY_TAG = stringTag("notify", "[A-Za-z0-9-]+");
/** Which agent originally created a PR (for post-merge/rejection re-invocation). */
export const ORIGIN_AGENT_TAG = stringTag("origin-agent", "[a-z][a-z0-9-]*");
/** Slash-command-equivalent dispatch marker on a bot-authored comment. */
export const DISPATCH_TAG = stringTag("dispatch", "[a-z][a-z0-9-]*");
/** Tags a posted result comment with which agent generated it (used by build_context_session.ts to exclude an agent's own past comments from its future shared context). */
export const AGENT_TAG = stringTag("agent", "[a-z][a-z0-9-]*");
/** Idempotency marker: orchestrator dispatch was already triggered for a given closed sub-issue's completion (see lib/aggregation.ts). Fresh tag with no pre-existing data, written as plain `N`. */
export const AGGREGATED_TAG = numericTag("aggregated", false);
/** Progress marker: which sub-issue's completion a progress comment reports on. Write-only (nothing parses it back); written as plain `N`. */
export const SUB_RESULT_TAG = numericTag("sub-result", false);

/**
 * Resolve a `parent` link from EITHER `atoma:parent` (issue -> issue) or
 * `atoma:parent-issue` (PR -> issue), preferring whichever is present --
 * mirrors the original combined regex used by resolve_notify.ts's
 * parent-chain walk, where a body may carry either form depending on
 * whether it's an issue or a PR.
 */
export function readAnyParentTag(text: string): number | undefined {
  return PARENT_TAG.read(text) ?? PARENT_ISSUE_TAG.read(text);
}

/**
 * tags.ts — canonical encode/decode for every `<!-- atoma:xxx=... -->`
 * HTML-comment marker Atoma embeds in issue/PR bodies and comments to carry
 * state across otherwise-stateless GitHub Actions workflow runs.
 *
 * This is the ONE place each tag's
 * wire format is defined; every reader/writer imports from here instead of
 * re-deriving its own regex.
 */
import { AGENT_NAME_PATTERN } from "./agent-name.ts";

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

/** Numeric-valued tag, e.g. `atoma:foo=42`. */
function numericTag(key: string): AtomaTag<number> {
  return makeTag(key, "\\d+", Number, String);
}

/** String-valued tag, e.g. `atoma:foo=bar-baz`. */
function stringTag(key: string, valuePattern: string): AtomaTag<string> {
  return makeTag(key, valuePattern, (raw) => raw, (value) => value);
}

/** Sub-issue -> orchestrator parent ISSUE link (set via `github__create_issue`'s `sub_issue: true`). */
export const PARENT_TAG = numericTag("parent");
/** PR -> the issue it closes/was created to address (set via `github__create_pr`). */
export const PARENT_ISSUE_TAG = numericTag("parent-issue");
/** Who to `@mention` on completion/escalation. */
export const NOTIFY_TAG = stringTag("notify", "[A-Za-z0-9-]+");
/** Which agent originally created a PR (for post-merge/rejection re-invocation). */
export const ORIGIN_AGENT_TAG = stringTag("origin-agent", AGENT_NAME_PATTERN);
/** Slash-command-equivalent dispatch marker on a bot-authored comment. */
export const DISPATCH_TAG = stringTag("dispatch", AGENT_NAME_PATTERN);
/** Tags a posted result comment with which agent generated it (used by reconcile_github_session.ts to exclude an agent's own past comments from its future shared context). */
export const AGENT_TAG = stringTag("agent", AGENT_NAME_PATTERN);

/**
 * Whether the run that posted this comment changed anything.
 *
 * `yes` when it pushed a commit, opened a pull request or merged one; `no` when it
 * ran and left the repository as it found it. Read by `domain/progress.ts`, which
 * counts consecutive `no`s rather than keeping a counter -- see `dispatch-chain.ts`
 * for why a counter in the session could not work.
 */
export const CHANGED_TAG = stringTag("changed", "yes|no");
/** Marks a GitHub comment as human-visible operational audit only; excluded from future LLM context reconciliation. */
export const LLM_CONTEXT_TAG = stringTag("llm-context", "include|exclude");
/** Idempotency marker: orchestrator dispatch was already triggered for a given closed sub-issue's completion (see lib/aggregation.ts). Fresh tag with no pre-existing data, written as plain `N`. */
export const AGGREGATED_TAG = numericTag("aggregated");
/** Progress marker: which sub-issue's completion a progress comment reports on. Write-only (nothing parses it back); written as plain `N`. */
export const SUB_RESULT_TAG = numericTag("sub-result");
/**
 * Counts how many times validation has sent a pull request back to the engineer.
 *
 * The auto-dispatch counter in `manage_dispatch_loop.ts` cannot bound this loop:
 * it only advances on a directive the agent itself wrote, and here the engineer
 * is dispatched by the validation workflow instead. So CI failing, the engineer
 * pushing, and CI failing again would repeat without limit, each turn costing a
 * model run. Counting the comments validation leaves is what stops it, and the
 * comments are worth leaving anyway -- they are where the engineer reads which
 * job failed.
 */
export const CI_RETRY_TAG = numericTag("ci-retry");

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

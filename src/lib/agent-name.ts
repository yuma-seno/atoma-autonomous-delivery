/**
 * agent-name.ts — the one definition of what a valid agent name looks like.
 *
 * An agent name is not decoration: it is spliced into a filesystem path
 * (`--agent-def .github/atoma/agent-definitions/<name>.md`), into shell text
 * inside generated workflow YAML, into `gh workflow run --field agent=<name>`,
 * and into the `atoma:agent`/`atoma:dispatch`/`atoma:origin-agent` comment
 * tags. So "what counts as a name" is a security boundary, and it was
 * previously written out five separate times -- four TypeScript regexes and one
 * bash ERE -- with no link between them.
 *
 * They had already drifted. `extract_directive.ts` used `[a-z][a-z0-9-]+`
 * (two characters minimum) where everything else used `*`, so a one-character
 * agent was dispatchable by comment and by `launch_sub_agent` but silently
 * ignored as a handoff directive. Nothing documented the difference, because it
 * was not a decision.
 *
 * `AGENT_NAME_PATTERN` is exported as a bare pattern BODY rather than a
 * `RegExp` because two of its consumers cannot use one: `lib/tags.ts` embeds it
 * in a larger HTML-comment regex, and `workflows/atoma-runner.wac.ts` generates
 * it into a bash `[[ =~ ]]` test. Generating the bash copy from this constant
 * is what makes the workflow's own check provably the same rule as the
 * TypeScript one, rather than a hand-kept-in-step transcription.
 */

/**
 * Lowercase letter, then lowercase letters/digits/hyphens. No anchors, no
 * capture group -- callers add what they need. Deliberately narrow: it has to
 * be safe as a path segment, as a shell word, and as a regex-free literal.
 */
export const AGENT_NAME_PATTERN = "[a-z][a-z0-9-]*";

const AGENT_NAME_RE = new RegExp(`^${AGENT_NAME_PATTERN}$`);

/**
 * True if `value` is a well-formed agent name. Says nothing about whether a
 * definition file for it exists -- callers that need that check it separately
 * (see `extract_directive.ts`, which requires a matching `<name>.md` before
 * dispatching, so a syntactically valid but unknown name cannot start a run).
 */
export function isAgentName(value: string): boolean {
  return AGENT_NAME_RE.test(value);
}

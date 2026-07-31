/**
 * github-context.ts — Typed references into the GitHub Actions `github`
 * context's `event` payload (`github.event.*`), backed by the official
 * `@octokit/webhooks-types` package (the same webhook payload schema GitHub
 * itself publishes and maintains).
 *
 * `github.event.*` is populated by GitHub's own servers at workflow-run
 * time -- no TypeScript layer can ever verify the actual runtime VALUE
 * matches what we declare (that would require reaching into GitHub's
 * servers). What this DOES catch: a typo'd or renamed FIELD NAME (e.g.
 * `.mreged` instead of `.merged`, or accessing a field that doesn't exist on
 * the actual payload for this workflow's specific trigger) at authoring
 * time, instead of only discovering it's silently empty/undefined the first
 * time the workflow actually runs.
 *
 * Usage: pick the concrete webhook event type matching the workflow's exact
 * trigger (e.g. `IssuesOpenedEvent` for `on: { issues: { types: ["opened"] } }`)
 * and a selector callback -- the callback never actually runs against real
 * data (a Proxy silently records which properties were accessed and
 * discards everything else), it exists purely so `event.foo.bar` is
 * type-checked against `T`.
 *
 *   githubEvent<IssuesOpenedEvent>((e) => e.issue.number)
 *     // '${{ github.event.issue.number }}'
 *   githubEventRaw<IssuesOpenedEvent>((e) => e.issue.number)
 *     // 'github.event.issue.number' (bare, for `if:`)
 */
function pathProxy(path: string[]): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        path.push(prop);
        return pathProxy(path);
      },
    },
  );
}

function resolvePath<T>(selector: (event: T) => unknown): string {
  const path: string[] = [];
  selector(pathProxy(path) as T);
  return path.join(".");
}

/** `${{ github.event.<path> }}`, for use as an ordinary value (`env:`, `with:`, `run:`). */
export function githubEvent<T>(selector: (event: T) => unknown): string {
  return `\${{ github.event.${resolvePath(selector)} }}`;
}

/**
 * Bare `github.event.<path>` (no `${{ }}`), for composing `if:` conditions
 * -- GitHub Actions warns that partially wrapping an `if:` expression in
 * `${{ }}` produces unpredictable results, so `if:` must stay either fully
 * bare or fully wrapped, matching the `.rawOutputs` convention used
 * elsewhere in this codebase (see `actions/base.ts`).
 */
export function githubEventRaw<T>(selector: (event: T) => unknown): string {
  return `github.event.${resolvePath(selector)}`;
}

/**
 * Author associations that imply write access to the repository.
 *
 * `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN` and `NONE`
 * are all outside contributors. GitHub reports the association on every event
 * that carries an actor, so no API call is needed to tell them apart.
 */
const MEMBER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

/**
 * Bare `if:` fragment asserting that the actor behind an event is a repository
 * member, for gating agent runs on the trigger being someone trusted.
 *
 * This is the whole trust boundary for event-driven entry points, and it is
 * sufficient because it is the only way an untrusted actor can reach one. Every
 * routing workflow fires on a human action — an agent's own issues, comments,
 * pull requests and merges are made with `GITHUB_TOKEN`, and GitHub starts no
 * workflow run for events its own token triggers. Agents reach the runner through
 * `workflow_dispatch` instead, which no outside contributor can invoke.
 *
 * So an outside contributor may open issues, comment and raise pull requests
 * freely; none of it starts an agent. A member acts, or nothing happens.
 *
 * @example
 *   isRepositoryMember(githubEventRaw<IssuesOpenedEvent>((e) => e.issue.author_association))
 */
export function isRepositoryMember(associationExpr: string): string {
  return `contains(fromJson('${JSON.stringify(MEMBER_ASSOCIATIONS)}'), ${associationExpr})`;
}

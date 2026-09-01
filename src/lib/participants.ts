/**
 * participants.ts — who a comment may notify.
 *
 * Read by everything that posts text an agent wrote: the result comment, and the
 * bodies of the issues and pull requests it opens. One place, because "who counts
 * as a participant" answered differently in two files is two policies nobody
 * decided on. What is done with the answer is `domain/mention.ts`.
 */
import { gh } from "./gh.ts";

/**
 * Everyone an agent may mention from a thread without notifying a stranger.
 *
 * Three sources, each best-effort and each read separately so a failure of one
 * does not take the others with it:
 *
 *   - whoever opened the issue or pull request
 *   - whoever has commented on it
 *   - the repository's collaborators
 *
 * The `issues` endpoint rather than `gh issue view`, because a pull request is an
 * issue to that endpoint and is not to that command -- one call that works for
 * both beats two that each work for half.
 *
 * An empty result is the fail-closed case and is correct: nothing confirmed means
 * nothing is exempt, and `domain/mention.ts` explains why that is the cheaper of
 * the two mistakes.
 */
export function knownParticipants(repo: string, number: string | number): string[] {
  if (!repo || !String(number).trim()) return [];
  const logins = new Set<string>();

  const collect = (args: string[], read: (json: unknown) => unknown[]) => {
    const { code, stdout } = gh(...args);
    if (code !== 0) return;
    try {
      for (const login of read(JSON.parse(stdout))) {
        if (typeof login === "string" && login) logins.add(login);
      }
    } catch {
      // A body that will not parse tells us nothing about who may be mentioned.
    }
  };

  collect(["api", `repos/${repo}/issues/${number}`], (json) => [
    (json as { user?: { login?: string } }).user?.login,
  ]);
  collect(["api", `repos/${repo}/issues/${number}/comments`, "--paginate"], (json) =>
    (json as { user?: { login?: string } }[]).map((comment) => comment.user?.login),
  );
  collect(["api", `repos/${repo}/collaborators`, "--paginate"], (json) =>
    (json as { login?: string }[]).map((person) => person.login),
  );

  return [...logins];
}

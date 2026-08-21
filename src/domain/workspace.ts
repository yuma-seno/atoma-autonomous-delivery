/**
 * workspace.ts — where an agent's working files go, and why it is a directory.
 *
 * ## The problem
 *
 * An agent does not walk straight to an implementation. On the way it writes
 * notes, a script to check something, an intermediate dump. **None of that had a
 * place**, so the deliverable branch was used instead: `commit_and_push` is
 * `git add -A`, so working files went in with the work.
 *
 * That was not an accident. It was the only way to keep a file across runs -- the
 * workspace is checked out fresh in a new job every time, so committed was the only
 * thing that survived. It cost three things: working files in the pull request for
 * a person to read past, build output and leftovers arriving the same way, and an
 * adopter needing five `.gitignore` lines before anything worked (#487 removed the
 * third).
 *
 * ## Why not a pair of tools
 *
 * The obvious design is `evacuate(file)` and `retrieve(file)`. It loses on the
 * criterion that matters: the agent has to REMEMBER which side each file is on.
 * Two verbs, an asymmetry between them, and a piece of state held in the model's
 * head rather than visible in what it types. **What has to be remembered is what
 * gets hallucinated.**
 *
 * A directory has one namespace, and the distinction is a path prefix -- so the
 * state is in the string the agent already writes. Nothing to remember.
 *
 * It also dissolves the hardest question in the tool design: whether retrieval
 * copies a file back (breaking the invariant) or only returns its contents (making
 * a saved script unrunnable). A directory is read, written and EXECUTED with the
 * tools that already exist.
 *
 * ## The invariant this exists to make true
 *
 *     Everything in the work tree is a deliverable. Nothing else survives.
 *
 * Worth more than any tool: an agent can be told this in one sentence, with no
 * table of which tool handles which file. #487 made the first half true by moving
 * the session and the logs out. This makes the second half true by giving the rest
 * somewhere to go.
 *
 * And `git add -A` becomes correct rather than convenient -- if everything in the
 * tree is a deliverable, adding all of it is right.
 *
 * ## A literal path, not a variable
 *
 * `/tmp/atoma-workspace`, spelled out. An environment variable would mean
 * `ls $ATOMA_WORKSPACE` returning nothing when the expansion failed, which reads
 * exactly like an empty directory. A form where "the variable was not set" and
 * "there is nothing there" are indistinguishable is a hallucination waiting to be
 * reported as fact.
 *
 * `/tmp` because it is writable by the tool user -- measured on the runner in #468
 * and #477, where `$HOME` was not -- and because it is the same string on every
 * run. `RUNNER_TEMP` changes per run, so it cannot be written down.
 */

/**
 * The one path. Absolute and constant, so it can be quoted verbatim to an agent.
 */
export const WORKSPACE_PATH = "/tmp/atoma-workspace";

/**
 * What an agent is told about it. One sentence, and this is the whole contract.
 *
 * Goes in the prompt template AND in `shell_execute`'s description. Both, because
 * a tool's own description was measured to carry more weight than the same words
 * in the system prompt (#325) -- and this sentence has to hold at the moment the
 * agent is choosing where to put a file, which is when it is reading the tool.
 */
export const WORKSPACE_SENTENCE =
  `Anything under ${WORKSPACE_PATH} survives into the next run on this issue and is shared with the other ` +
  `agents working on it. Nothing else outside the repository survives. Put notes, scratch scripts and ` +
  `intermediate output there rather than in the repository, where they would be committed as part of the work.`;

/** Which issue's workspace a run shares, and whether that was known or assumed. */
export interface WorkspaceScope {
  /** The root issue number, as a string for path building. */
  rootIssue: string;
  /** True when the parent chain was read, false when it was assumed from the target. */
  resolved: boolean;
  /** Why, when it was assumed. Empty when resolved. */
  why: string;
}

/**
 * Resolve the workspace's owner from a parent chain.
 *
 * The scope is the ROOT issue rather than the run's own target, because a
 * decomposed issue is one piece of work: the orchestrator's plan, the engineer's
 * analysis and the reviewer reading both belong in one place. A pull request shares
 * its issue's workspace for the same reason -- an agent starts on the issue and
 * continues on the pull request, and a workspace tied to the GitHub object would
 * vanish at the handover. What it is tied to is the WORK.
 *
 * `parents` is the chain from the run's target upward, as far as it could be read.
 *
 * ## When the chain cannot be read, the workspace is private
 *
 * Falling back to the target's own number, and the direction is deliberate:
 *
 * - sharing what should have been separate puts an unrelated issue's working files
 *   in front of an agent, which it has no way to recognise as foreign
 * - separating what should have been shared costs a child agent the parent's notes,
 *   which is an inconvenience it can see and work around
 *
 * So an unreadable parent means "your own", not "the last one that worked".
 */
export function workspaceScope(target: string | number, parents: readonly number[], why = ""): WorkspaceScope {
  const root = parents.length > 0 ? parents[parents.length - 1]! : undefined;
  if (root === undefined) {
    return { rootIssue: String(target), resolved: why === "", why };
  }
  return { rootIssue: String(root), resolved: true, why: "" };
}

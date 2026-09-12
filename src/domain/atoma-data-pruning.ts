/**
 * atoma-data-pruning.ts — which stored paths belong to work that is over.
 *
 * ## What is pruned, and why that rule and not a number of days
 *
 * `atoma-data` grows and nothing removes anything. Measured, the pain is still far
 * off — 513 commits weigh 9 MB, because a session is appended-to JSON and git's delta
 * compression works on it — but the direction is one way and nobody was watching it.
 *
 * The obvious rule is an age: archive after thirty days. The better one is the issue's
 * own state, because **a closed issue's session is dead on the first day, not the
 * thirtieth**, and an open issue's session is worth keeping however old it is. Days are
 * a proxy for "nobody will need this"; the issue already answers that question.
 *
 * Re-opening is the cost. A re-opened issue comes back without its session, and the run
 * rebuilds one from the issue as `/engineer recover` does. That was accepted
 * deliberately: it is a slower first run, against a store that otherwise grows forever.
 *
 * ## What is not pruned, whatever its issue says
 *
 * An issue that a run is working on right now. A closed issue can still be mid-run —
 * the agent closes it and the job continues — and deleting a session under a live run
 * turns a save into a resurrection of the file this just removed, or a restore into a
 * silent amnesia. The in-progress label is what says so, and it is checked.
 *
 * ## Both layouts, and both trees
 *
 * Sessions have been stored two ways: `sessions/issue-7-engineer.json` early, and
 * `sessions/issue-7/engineer.json` with `sessions/issue-7/archive/…` beside it since.
 * Both start `issue-<number>`, which is all this needs. `workspace/issue-7/…` is the
 * same shape and dies of the same cause, so it is pruned by the same pass.
 */

/**
 * The one tree this prunes, and why sessions are not in it.
 *
 * Sessions are kept permanently. They were pruned once, and restored the same day for
 * a reason the day itself supplied: they are the only measurement substrate this
 * project has. The search guard's threshold, the cause of a 6.4M-token run, and the
 * finding that the edit/verify loop does not occur in 354 sessions all came from
 * reading them, and none of them needed a record to be added first. An aggregate
 * answers the questions it was built to answer; the raw sessions answer the ones
 * nobody has thought of yet, which is where every one of those three came from.
 *
 * They are also cheap, which is what makes the choice easy rather than a trade. A
 * session is appended-to JSON, so git's delta compression works on it: measured over
 * this repository, every version of every session is 40 MB of text and **4.7 MB on
 * disk**. The index was the expensive thing here and it now lives on its own branch.
 *
 * The escape directory is different in the way that matters. Its contents are
 * arbitrary -- whatever an agent chose to put there -- so nothing can be assumed about
 * how it compresses, and a closed issue's scratch files answer no question at all.
 */
const OWNED_TREES = ["workspace/"];

/**
 * The issue a stored path belongs to, or `undefined` if it belongs to none.
 *
 * Deliberately strict about what it recognises. A path this cannot read is left alone
 * rather than guessed at, because the guess would be a deletion.
 */
export function issueNumberOf(path: string): number | undefined {
  const tree = OWNED_TREES.find((prefix) => path.startsWith(prefix));
  if (tree === undefined) return undefined;
  const rest = path.slice(tree.length);
  // `issue-7-engineer.json` and `issue-7/engineer.json` both end the number at a
  // hyphen, a slash or a dot -- which is every separator either layout uses.
  const match = /^issue-(\d+)(?:[-/.]|$)/.exec(rest);
  if (match === undefined || match === null) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** What the pruner decided, in the form the commit message and the log both want. */
export interface PruneDecision {
  /** Paths to delete, in the order given. */
  paths: string[];
  /** The issues those paths belong to, ascending. */
  issues: number[];
}

/**
 * The paths belonging to issues that are over.
 *
 * `isOver` answers for one issue and is asked once per issue rather than once per path,
 * because a busy issue has a dozen files and the answer cannot differ between them.
 * Anything it cannot answer for is kept: an unreadable issue is not evidence that its
 * session is disposable.
 */
export function prunablePaths(paths: readonly string[], isOver: (issue: number) => boolean): PruneDecision {
  const verdicts = new Map<number, boolean>();
  const out: string[] = [];
  const issues = new Set<number>();

  for (const path of paths) {
    const issue = issueNumberOf(path);
    if (issue === undefined) continue;
    if (!verdicts.has(issue)) verdicts.set(issue, isOver(issue));
    if (!verdicts.get(issue)) continue;
    out.push(path);
    issues.add(issue);
  }

  return { paths: out, issues: [...issues].sort((a, b) => a - b) };
}

/**
 * What the commit says it did.
 *
 * The issue numbers rather than the file count, because the numbers are what somebody
 * checks against when they wonder where a session went.
 */
export function pruneCommitMessage(decision: PruneDecision): string {
  const files = `${decision.paths.length} file${decision.paths.length === 1 ? "" : "s"}`;
  const listed = decision.issues.map((n) => `#${n}`).join(", ");
  return `atoma: prune ${files} from closed issues (${listed})`;
}

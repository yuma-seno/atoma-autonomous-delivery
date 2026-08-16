/**
 * merge-readiness.ts — decides whether a pull request may be merged, and says
 * why not when it may not.
 *
 * The verdict comes from the repository's own branch protection, not from an
 * opinion held here. GitHub computes `mergeStateStatus` against whatever the
 * active ruleset requires, and the ruleset is a reviewed file
 * (`.github/rulesets/*.json`), so changing what "mergeable" means is a change to
 * that file — this module and the tools built on it follow automatically, with no
 * second definition to keep in step.
 *
 * That matters because the previous version WAS a second definition: it decided
 * on its own that checks must be green and conflicts absent. Anything the
 * repository required but this file did not know about went unenforced, and it
 * governed only the agent path — a person merging from the GitHub UI walked past
 * it entirely. Protection now applies to both, and this reports it.
 *
 * The remaining local input is `merge_policy`, which is Atoma's own concept and
 * has no GitHub equivalent.
 */

/** A single check run, reduced to what reporting needs. */
export interface CheckRun {
  name: string;
  /** GitHub `status`: queued | in_progress | completed. */
  status: string;
  /** GitHub `conclusion`, null while incomplete. */
  conclusion: string | null;
  detailsUrl?: string;
}

export interface MergeSignals {
  /**
   * GitHub's computed merge state, evaluated against the active ruleset:
   * CLEAN | BLOCKED | DIRTY | BEHIND | UNSTABLE | DRAFT | HAS_HOOKS | UNKNOWN.
   * This is the verdict; everything else here only explains it.
   */
  mergeStateStatus: string;
  state: string;
  /**
   * Whether the pull request is a draft, read from the pull request itself.
   *
   * Not derived from `mergeStateStatus`. GitHub documents `DRAFT` as one of its
   * values, but reports `CLEAN` for a draft in practice, so the `DRAFT` case below
   * never fired and a draft was reported ready to merge. `isDraft` is an attribute
   * of the pull request rather than a computed verdict, so it does not move.
   */
  isDraft: boolean;
  /**
   * Whether the pull request was opened by an agent rather than by a person.
   *
   * Read from the author's type, not from a name, so it does not depend on which
   * identity a deployment runs under.
   *
   * `merge_policy` bounds how much an agent decides on its own, and the work it
   * was meant to bound is the agent's own. A person opening a pull request is
   * proposing something and asking what a reviewer makes of it; merging it for
   * them takes that decision away, and does it before they have read the review.
   * So the policy applies to agent-authored pull requests, and a person's own
   * stays theirs to merge.
   */
  authoredByAgent: boolean;
  /** Check runs on the head commit, used to name what is failing or pending. */
  checks: CheckRun[];
  /**
   * Status check contexts the ruleset requires, from
   * `GET /repos/{owner}/{repo}/rules/branches/{branch}`. Empty when the branch
   * has no such rule.
   */
  requiredChecks: string[];
  /** `merge_policy` from config.json. Atoma's own gate, not GitHub's. */
  mergePolicy: string;
  /**
   * Paths this pull request changes that govern how agents run — workflows,
   * agent definitions, tool configuration, rulesets.
   *
   * Empty for ordinary work, which is nearly every pull request. Non-empty means
   * the change alters the machinery that decides what an agent may do, including
   * the parts that hold credentials and the parts that gate this very merge.
   */
  governancePaths: string[];
}

export type BlockerKind =
  | "not-open"
  | "draft"
  | "conflicting"
  | "behind"
  | "blocked"
  | "checks-missing"
  | "checks-pending"
  | "checks-failing"
  | "mergeability-unknown"
  | "merge-policy"
  | "human-authored"
  | "governance-change";

export interface Blocker {
  kind: BlockerKind;
  /** One line an agent can act on or relay to a human. */
  detail: string;
}

export interface MergeReadiness {
  ready: boolean;
  blockers: Blocker[];
  /** True when a required check has never run on the head commit. */
  needsCiDispatch: boolean;
}

/** Conclusions that satisfy a required check. Skipped and neutral are not failures. */
const PASSING = new Set(["success", "neutral", "skipped"]);

/**
 * The deployed files that decide how an agent runs, and so what it may reach.
 *
 * Deployed paths, not source paths: this is what an adopter's repository looks
 * like. A template repository developing the same files under `src/` is doing
 * ordinary work on ordinary files, and adds its own patterns if it wants them
 * covered.
 *
 * One pattern rather than a list of the directories that matter, because the
 * list was wrong. It named `workflows`, `actions`, `atoma` and `rulesets` and
 * omitted `.github/scripts/**` — where the runner's own control logic lives, run
 * by a job holding `contents: write`, `issues: write`, `pull-requests: write`
 * and `actions: write`. An agent could rewrite the rule releasing the
 * in-progress guard, or the auto-dispatch loop limit, and merge it unreviewed.
 *
 * Nothing chose that; enumerating did. `.github/scripts/` arrived after the list
 * was written and nobody added it. A list of exceptions has to be revisited every
 * time the tree grows, and it silently fails when it is not — so this covers the
 * directory and lets a project narrow it, rather than naming parts and hoping the
 * next addition is noticed.
 *
 * It reaches a few files that are not an agent's limits — `dependabot.yml`,
 * `CODEOWNERS`, issue templates. Those change rarely, and the first two are
 * things a person should see change anyway.
 */
export const DEFAULT_GOVERNED_PATHS = [".github/**"] as const;

/** A file whose changer probably meant to change what CI or a deployment does. */
function isGeneratedWorkflow(path: string): boolean {
  return path.startsWith(".github/workflows/");
}

/**
 * Which of `files` a pattern claims.
 *
 * Deliberately not a glob library. A pattern is either a literal path or a
 * directory followed by `/**`, because that is what naming a control surface
 * needs, and a half-implemented glob would be read as a full one.
 */
export function governedPathsIn(files: string[], patterns: readonly string[]): string[] {
  return files.filter((file) =>
    patterns.some((pattern) =>
      pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern,
    ),
  );
}

/**
 * Explain a BLOCKED verdict in terms of the required checks, so a refusal names
 * the check to fix rather than restating that GitHub said no.
 */
function explainRequiredChecks(signals: MergeSignals): Blocker[] {
  const blockers: Blocker[] = [];
  const byName = new Map(signals.checks.map((c) => [c.name, c]));

  for (const context of signals.requiredChecks) {
    const run = byName.get(context);
    if (!run) {
      blockers.push({
        kind: "checks-missing",
        detail: `required check "${context}" has not run on the head commit`,
      });
    } else if (run.status !== "completed") {
      blockers.push({
        kind: "checks-pending",
        detail: `required check "${context}" is ${run.status}`,
      });
    } else if (!PASSING.has((run.conclusion ?? "").toLowerCase())) {
      const where = run.detailsUrl ? ` (${run.detailsUrl})` : "";
      blockers.push({
        kind: "checks-failing",
        detail: `required check "${context}" concluded ${run.conclusion}${where}`,
      });
    }
  }
  return blockers;
}

export function decideMergeReadiness(signals: MergeSignals): MergeReadiness {
  const blockers: Blocker[] = [];

  if (signals.state?.toUpperCase() !== "OPEN") {
    blockers.push({ kind: "not-open", detail: `pull request state is ${signals.state}, not OPEN` });
  }

  // Before the verdict, because the verdict does not carry this. GitHub reports
  // `CLEAN` for a draft, so relying on the `DRAFT` case below reported a draft as
  // ready and left the refusal to come back from the merge call as a raw API error
  // no blocker kind described.
  if (signals.isDraft) {
    blockers.push({ kind: "draft", detail: "pull request is a draft; mark it ready for review first" });
  }

  switch (signals.mergeStateStatus?.toUpperCase()) {
    case "CLEAN":
    case "UNSTABLE": // a non-required check is failing; the ruleset permits merging
      break;
    case "DRAFT":
      // Kept although `isDraft` above already covers it, so this does not break if
      // GitHub starts returning the value its own docs list. Guarded to avoid
      // reporting the same blocker twice when it does.
      if (!signals.isDraft) {
        blockers.push({ kind: "draft", detail: "pull request is a draft; mark it ready for review first" });
      }
      break;
    case "DIRTY":
      blockers.push({
        kind: "conflicting",
        detail: "branch conflicts with the base; call github__sync_branch and resolve before merging",
      });
      break;
    case "BEHIND":
      blockers.push({
        kind: "behind",
        detail: "branch is behind the base and the ruleset requires it current; call github__sync_branch",
      });
      break;
    case "BLOCKED": {
      // Blocked by branch protection. Name the specific required checks when we
      // can; fall back to the raw verdict when the cause is something else the
      // ruleset requires (a review, an unresolved thread).
      const explained = explainRequiredChecks(signals);
      if (explained.length > 0) blockers.push(...explained);
      else
        blockers.push({
          kind: "blocked",
          detail:
            "branch protection blocks this merge for a reason outside the required checks " +
            "(for example a required review or an unresolved conversation); inspect the pull request",
        });
      break;
    }
    default:
      blockers.push({
        kind: "mergeability-unknown",
        detail: `GitHub reports mergeStateStatus=${signals.mergeStateStatus ?? "null"}; retry shortly`,
      });
  }

  // A person's pull request is theirs to merge, whatever the policy says. They
  // opened it to hear what a reviewer makes of it, and merging it for them ends
  // that before they have read the answer.
  if (!signals.authoredByAgent) {
    blockers.push({
      kind: "human-authored",
      detail: "a person opened this pull request; review it and report, but leave the merge to them",
    });
  }

  if (signals.mergePolicy !== "auto") {
    blockers.push({
      kind: "merge-policy",
      detail: `merge_policy is '${signals.mergePolicy}', not 'auto'; a human performs the merge`,
    });
  }

  // Every other gate here is something an agent may satisfy and then merge. This
  // one it may not, because the change would alter the gates themselves.
  //
  // Workflows, agent definitions, tool configuration and rulesets are where an
  // agent's limits live — which credentials reach a run, which commands a hook
  // refuses, what a ruleset requires before a merge. An agent that can merge a
  // change to those can widen its own reach, and no later check catches it: the
  // next run already obeys the new file.
  //
  // Not a suspicion that an agent means to. A prompt injection carried in an
  // issue body, or a plain mistake, reaches just as far, and both stop at a
  // person reading the diff.
  if (signals.governancePaths.length > 0) {
    const shown = signals.governancePaths.slice(0, 5).join(", ");
    const rest = signals.governancePaths.length - 5;
    blockers.push({
      kind: "governance-change",
      detail:
        `this pull request changes how agents themselves run (${shown}${rest > 0 ? `, +${rest} more` : ""}); ` +
        "review it and report, but leave the merge to a person" +
        // Said here because this is the moment someone is looking. The commonest
        // reason to touch a generated workflow is to change what CI or a
        // deployment does, and under Atoma that is not where those live -- so
        // name the place it does live rather than only refusing the merge.
        (signals.governancePaths.some(isGeneratedWorkflow)
          ? ". If the intent was to change what CI or deployment does, that belongs in " +
            "`.github/atoma/config.json` (`checks.commands`, `deploy.targets`) rather than in a " +
            "workflow file — an agent can write config and cannot write a workflow. If this is an " +
            "upgrade of the generated deliverable, it is exactly what a person should be merging"
          : ""),
    });
  }

  // Worth dispatching CI only when a required check simply has not run, and
  // nothing else stands in the way — dispatching against a conflicting or draft
  // branch burns a run on a commit that has to change anyway.
  const needsCiDispatch =
    blockers.length > 0 && blockers.every((b) => b.kind === "checks-missing");

  return { ready: blockers.length === 0, blockers, needsCiDispatch };
}

/** Render blockers as a numbered list for a tool result or an issue comment. */
export function formatBlockers(blockers: Blocker[]): string {
  return blockers.map((b, i) => `${i + 1}. [${b.kind}] ${b.detail}`).join("\n");
}

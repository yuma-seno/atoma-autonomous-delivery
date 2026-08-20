/**
 * merge-gates.ts — conditions under which an agent must not merge, declared by
 * the project rather than hardcoded here.
 *
 * ## Why this is not a required status check
 *
 * A required check stops everyone. The thing wanted here stops only the agent:
 * "a pull request that adds a database migration is a person's to merge" does not
 * mean the merge is forbidden, it means the judgement is not an agent's to make.
 * Branch protection cannot express that, because it does not know who is merging.
 *
 * `governed_paths` already has exactly this property and is the model. It says
 * "changes under `.github/**` fall to a person", the agent reviews and reports,
 * and a person merges. What it lacks is expressiveness: it matches paths and
 * nothing else, so `db/migrations/**` is sayable but "only when a migration is
 * ADDED" is not. These gates are that generalisation.
 *
 * ## Why declarative rather than a script
 *
 * The first proposal was a script per gate, spawned like `tools.yaml`'s
 * `before_tool` hook, with the exit code as the verdict. It is more expressive --
 * a script can read a migration and notice it drops a production table, which no
 * amount of configuration can.
 *
 * It is also the one decision here that is hard to take back, and it buys that
 * expressiveness with four new failure modes: a timeout, a crash whose default
 * has to be chosen, a program that must itself be read from the machinery rather
 * than from the pull request under review, and arbitrary code on the path that
 * decides whether that code may merge. Configuration has none of those. It is
 * read from `config.json`, which `loadConfig()` already resolves under
 * `ATOMA_MACHINERY_ROOT`, so a pull request cannot weaken the gate judging it --
 * for free, with nothing to plumb.
 *
 * So: conditions now, and a script escape hatch left unbuilt until a real case
 * needs one. The shape here does not stand in the way of adding it -- a gate is
 * an object with a `reason`, and a `run` key alongside `when` would be additive.
 *
 * ## Why unknown keys are an error
 *
 * A typo in `files_added` matches nothing, and a gate that matches nothing looks
 * identical to a gate that was never needed. Nobody finds out until the merge
 * they wanted stopped goes through quietly. `DEFAULT_GOVERNED_PATHS` carries the
 * same lesson from the other direction: an enumeration that silently omitted
 * `.github/scripts/` let an agent merge changes to its own limits. Silence is the
 * failure mode to design against, so every key is checked and anything
 * unrecognised is reported.
 */
import { pathMatches, pathPatternProblem } from "./path-patterns.ts";

/**
 * What happened to one file in a pull request.
 *
 * Three states, not GitHub's seven. `copied` is an addition, `changed` is a
 * modification, and a rename is reported by the adapter as an addition at the new
 * path AND a removal at the old one -- otherwise `git mv` into `db/migrations/`
 * would walk past a `files_added` gate while plainly adding a migration.
 */
export type FileStatus = "added" | "removed" | "modified";

export interface ChangedFile {
  readonly path: string;
  readonly status: FileStatus;
}

/**
 * When a gate applies. Conditions AND within a gate, gates OR across the list --
 * so one gate is one situation, and more situations are more gates.
 *
 * An absent condition is not a condition. Empty arrays and an empty
 * `titleMatches` mean "this gate does not constrain that", which is why a gate
 * with no conditions at all is rejected rather than read as "always".
 */
export interface MergeGateConditions {
  readonly filesAdded: readonly string[];
  readonly filesRemoved: readonly string[];
  readonly filesModified: readonly string[];
  /** Added, removed or modified -- the union, and what `governed_paths` matches on. */
  readonly filesChanged: readonly string[];
  /** Matches when the pull request carries any one of these labels. */
  readonly labels: readonly string[];
  /** Case-insensitive regular expression source, or "" for no title condition. */
  readonly titleMatches: string;
}

export interface MergeGate {
  /** Said to a person, so it is theirs to write. Relayed verbatim in the blocker. */
  readonly reason: string;
  readonly when: MergeGateConditions;
}

export interface MergeGatesResolution {
  readonly gates: readonly MergeGate[];
  readonly problems: readonly string[];
}

/** What a gate is evaluated against. */
export interface PullRequestFacts {
  readonly changedFiles: readonly ChangedFile[];
  readonly labels: readonly string[];
  readonly title: string;
}

export interface MergeGateMatch {
  readonly reason: string;
  /** What made it match, named so the person reading the refusal can see why. */
  readonly evidence: readonly string[];
}

/**
 * Every condition a gate may name.
 *
 * Exported because a contract test used to keep its own copy to compare against the
 * documentation — so adding one here and forgetting the test's array left the condition
 * undocumented with both doc tests still green, which is the gap that test exists to
 * close.
 */
export const CONDITION_KEYS = [
  "files_added",
  "files_removed",
  "files_modified",
  "files_changed",
  "labels",
  "title_matches",
] as const;

const GATE_KEYS = ["reason", "when"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a condition that is a list of path patterns, checking each one's form. */
function readPatterns(raw: unknown, where: string, problems: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be an array of path patterns.`);
    return [];
  }
  if (raw.length === 0) {
    problems.push(`${where} is empty, so it constrains nothing; remove the key instead.`);
    return [];
  }
  const patterns: string[] = [];
  for (const entry of raw) {
    // Checked here rather than left to `pathPatternProblem`'s own `typeof`
    // guard. That guard is unreachable by its own signature, so casting a
    // `number` to `string` to reach it made this reader depend on another
    // module's defensive code through an assertion that says the opposite.
    // `readLabels` below already does it this way.
    if (typeof entry !== "string") {
      problems.push(`${where}: every pattern must be a string; found ${JSON.stringify(entry)}.`);
      continue;
    }
    const problem = pathPatternProblem(entry);
    if (problem) {
      problems.push(`${where}: ${problem}`);
      continue;
    }
    patterns.push(entry.trim());
  }
  return patterns;
}

function readLabels(raw: unknown, where: string, problems: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((label) => typeof label !== "string" || label.trim() === "")) {
    problems.push(`${where} must be an array of non-empty label names.`);
    return [];
  }
  if (raw.length === 0) {
    problems.push(`${where} is empty, so it constrains nothing; remove the key instead.`);
    return [];
  }
  return (raw as string[]).map((label) => label.trim());
}

function readTitleMatches(raw: unknown, where: string, problems: string[]): string {
  if (raw === undefined) return "";
  if (typeof raw !== "string" || raw.trim() === "") {
    problems.push(`${where} must be a non-empty regular expression.`);
    return "";
  }
  try {
    new RegExp(raw, "i");
  } catch (error) {
    problems.push(`${where} is not a valid regular expression: ${(error as Error).message}`);
    return "";
  }
  return raw;
}

function constrainsAnything(when: MergeGateConditions): boolean {
  return (
    when.filesAdded.length > 0 ||
    when.filesRemoved.length > 0 ||
    when.filesModified.length > 0 ||
    when.filesChanged.length > 0 ||
    when.labels.length > 0 ||
    when.titleMatches !== ""
  );
}

/**
 * Validate `merge_gates`.
 *
 * All or nothing, for the same reason `resolveDeployTargets` is: a partly
 * honoured gate list reports that the gates ran while the one that mattered was
 * dropped. The caller turns any problem into a blocker, so an unusable
 * declaration stops the merge instead of being skipped.
 */
export function resolveMergeGates(raw: unknown): MergeGatesResolution {
  if (raw === undefined || raw === null) return { gates: [], problems: [] };
  if (!Array.isArray(raw)) {
    return { gates: [], problems: ["`merge_gates` must be an array of gate objects."] };
  }

  const problems: string[] = [];
  const gates: MergeGate[] = [];

  raw.forEach((entry, index) => {
    const where = `\`merge_gates[${index}]\``;
    if (!isRecord(entry)) {
      problems.push(`${where} must be an object with \`reason\` and \`when\`.`);
      return;
    }

    for (const key of Object.keys(entry)) {
      if (!(GATE_KEYS as readonly string[]).includes(key)) {
        problems.push(`${where}: unknown key \`${key}\`; a gate has \`reason\` and \`when\`.`);
      }
    }

    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (reason === "") {
      problems.push(`${where}: \`reason\` must say why a person should merge this, in their words.`);
    }

    if (!isRecord(entry.when)) {
      problems.push(
        `${where}: \`when\` must be an object naming at least one condition ` +
          `(${CONDITION_KEYS.join(", ")}).`,
      );
      return;
    }
    const declared = entry.when;

    for (const key of Object.keys(declared)) {
      if (!(CONDITION_KEYS as readonly string[]).includes(key)) {
        problems.push(
          `${where}: unknown condition \`${key}\`. A misspelled condition matches nothing, which ` +
            `looks exactly like a gate nobody needed -- so it is an error rather than a no-op. ` +
            `Known conditions: ${CONDITION_KEYS.join(", ")}.`,
        );
      }
    }

    const when: MergeGateConditions = {
      filesAdded: readPatterns(declared.files_added, `${where}.when.files_added`, problems),
      filesRemoved: readPatterns(declared.files_removed, `${where}.when.files_removed`, problems),
      filesModified: readPatterns(declared.files_modified, `${where}.when.files_modified`, problems),
      filesChanged: readPatterns(declared.files_changed, `${where}.when.files_changed`, problems),
      labels: readLabels(declared.labels, `${where}.when.labels`, problems),
      titleMatches: readTitleMatches(declared.title_matches, `${where}.when.title_matches`, problems),
    };

    // A gate with no conditions would stop every merge. That is already sayable
    // as `merge_policy: "manual"`, and someone who wrote it here meant something
    // narrower and lost it to a typo.
    if (!constrainsAnything(when)) {
      problems.push(
        `${where}: \`when\` names no usable condition, so this gate would stop every merge. ` +
          `Set \`merge_policy\` to "manual" if that is the intent.`,
      );
      return;
    }

    gates.push({ reason, when });
  });

  return problems.length > 0 ? { gates: [], problems } : { gates, problems };
}

const ALL_STATUSES: readonly FileStatus[] = ["added", "removed", "modified"];

/** Files with one of `statuses` that any of `patterns` claims. */
function filesMatching(
  files: readonly ChangedFile[],
  statuses: readonly FileStatus[],
  patterns: readonly string[],
): string[] {
  if (patterns.length === 0) return [];
  return files
    .filter((file) => statuses.includes(file.status))
    .filter((file) => patterns.some((pattern) => pathMatches(file.path, pattern)))
    .map((file) => file.path);
}

/**
 * The gates that apply to this pull request, in declared order.
 *
 * A condition that is present and does not hold rules the gate out; a condition
 * that is absent is not consulted. So a gate naming both `files_added` and
 * `labels` applies only to a pull request that does both, and the evidence names
 * what satisfied each part.
 */
export function matchMergeGates(
  gates: readonly MergeGate[],
  facts: PullRequestFacts,
): readonly MergeGateMatch[] {
  const matches: MergeGateMatch[] = [];

  for (const gate of gates) {
    const { when } = gate;
    const evidence: string[] = [];

    const fileConditions: { patterns: readonly string[]; statuses: readonly FileStatus[] }[] = [
      { patterns: when.filesAdded, statuses: ["added"] },
      { patterns: when.filesRemoved, statuses: ["removed"] },
      { patterns: when.filesModified, statuses: ["modified"] },
      { patterns: when.filesChanged, statuses: ALL_STATUSES },
    ];

    let applies = true;
    for (const condition of fileConditions) {
      if (condition.patterns.length === 0) continue;
      const hits = filesMatching(facts.changedFiles, condition.statuses, condition.patterns);
      if (hits.length === 0) {
        applies = false;
        break;
      }
      evidence.push(...hits);
    }
    if (!applies) continue;

    if (when.labels.length > 0) {
      const hits = facts.labels.filter((label) => when.labels.includes(label));
      if (hits.length === 0) continue;
      evidence.push(...hits.map((label) => `label:${label}`));
    }

    if (when.titleMatches !== "") {
      if (!new RegExp(when.titleMatches, "i").test(facts.title)) continue;
      evidence.push(`title:${facts.title}`);
    }

    matches.push({ reason: gate.reason, evidence });
  }

  return matches;
}

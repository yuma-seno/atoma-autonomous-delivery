/**
 * deploy-targets.ts — what this project deploys, and which event deploys it.
 *
 * A deployment is a name, a trigger and a list of commands. It is configuration
 * rather than a workflow file because an agent can write configuration and
 * cannot write a workflow: GITHUB_TOKEN is refused on `.github/workflows/**` by
 * identity, on every path and every branch, so a project whose CD an agent is
 * expected to author has to express it somewhere else. Everything a deployment
 * actually does — building, uploading, calling a provider's CLI — is a command,
 * and commands are ordinary file content.
 *
 * ## Why the trigger is here and not in the workflow
 *
 * `atoma-deploy.yml` listens for every tag, and asks this module whether any
 * target wanted that one. It cannot listen selectively, because `on:` takes no
 * expression and so cannot be driven from configuration. Filtering after the
 * fact costs a few seconds of runner time on a tag nobody deploys, which is the
 * price of letting the pattern live somewhere an agent can edit.
 *
 * Merges cost nothing at all, because a merge does not start this workflow by
 * event: an agent's merge uses GITHUB_TOKEN and fires no `push`, so `dispatchCd`
 * starts the run explicitly. It asks this module first and does not dispatch
 * when nothing matches.
 *
 * Schedules are deliberately absent. A cron expression can only be written in
 * `on:`, so it cannot come from configuration, and a fixed daily cron that
 * checks the time in a script burns 24 runs a day to do nothing.
 */

/** When a target deploys without anyone asking. */
export type DeployTrigger = "merge" | "tag" | "manual";

export interface DeployTarget {
  /** How a person or an agent names this deployment when dispatching it. */
  readonly name: string;
  /**
   * `merge` deploys after a pull request lands on the base branch, `tag` when a
   * matching tag is pushed, `manual` only when dispatched by name.
   */
  readonly on: DeployTrigger;
  /** Tag patterns, for `on: tag`. A literal, or a prefix followed by `*`. */
  readonly tags: readonly string[];
  /** Run in order, stopping at the first failure. */
  readonly commands: readonly string[];
}

export interface DeployTargetsResolution {
  readonly targets: readonly DeployTarget[];
  readonly problems: readonly string[];
}

const TRIGGERS: readonly DeployTrigger[] = ["merge", "tag", "manual"];

/** A name a person types on a dispatch form and an agent writes into config. */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a `commands`-shaped array, collecting its own problems. */
function readCommands(raw: unknown, where: string, problems: string[]): string[] {
  if (!Array.isArray(raw)) {
    problems.push(`${where}: \`commands\` must be an array of shell commands.`);
    return [];
  }
  const commands: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      problems.push(`${where}: every command must be a non-empty string; found ${JSON.stringify(entry)}.`);
      continue;
    }
    commands.push(entry);
  }
  if (commands.length === 0 && problems.length === 0) {
    problems.push(`${where}: declares no commands, so it would deploy nothing.`);
  }
  return commands;
}

/**
 * Validate `deploy.targets`.
 *
 * Returns targets only when every one of them is usable. A half-honoured
 * deployment list is the worst outcome available: the run reports success having
 * skipped the target that mattered.
 */
export function resolveDeployTargets(raw: unknown): DeployTargetsResolution {
  if (raw === undefined || raw === null) return { targets: [], problems: [] };
  if (!Array.isArray(raw)) {
    return { targets: [], problems: ["`deploy.targets` must be an array."] };
  }

  const problems: string[] = [];
  const targets: DeployTarget[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const where = `\`deploy.targets[${index}]\``;
    if (!isRecord(entry)) {
      problems.push(`${where} must be an object.`);
      return;
    }

    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!NAME_PATTERN.test(name)) {
      problems.push(`${where}: \`name\` must be lowercase letters, digits and hyphens — e.g. 'production'.`);
      return;
    }
    if (seen.has(name)) {
      problems.push(`${where}: '${name}' is declared more than once.`);
      return;
    }

    const on = entry.on;
    if (typeof on !== "string" || !TRIGGERS.includes(on as DeployTrigger)) {
      problems.push(`${where}: \`on\` must be one of ${TRIGGERS.map((t) => `'${t}'`).join(", ")}.`);
      return;
    }
    const trigger = on as DeployTrigger;

    const tagsRaw = entry.tags ?? [];
    if (!Array.isArray(tagsRaw) || tagsRaw.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
      problems.push(`${where}: \`tags\` must be an array of non-empty patterns.`);
      return;
    }
    const tags = (tagsRaw as string[]).map((tag) => tag.trim());

    // A tag target with no pattern would deploy on every tag in the repository,
    // which is never what someone meant to write and is expensive to discover.
    if (trigger === "tag" && tags.length === 0) {
      problems.push(`${where}: \`on: tag\` needs at least one pattern in \`tags\` — e.g. ["v*"].`);
      return;
    }
    if (trigger !== "tag" && tags.length > 0) {
      problems.push(`${where}: \`tags\` only applies to \`on: tag\`; this target is \`on: ${trigger}\`.`);
      return;
    }

    const before = problems.length;
    const commands = readCommands(entry.commands, where, problems);
    if (problems.length > before) return;

    seen.add(name);
    targets.push({ name, on: trigger, tags, commands });
  });

  return problems.length > 0 ? { targets: [], problems } : { targets, problems };
}

/**
 * Whether a tag pattern claims a tag.
 *
 * Deliberately not a glob library, for the same reason `governedPathsIn` is not:
 * a pattern is a literal or a prefix followed by `*`, because that is what tag
 * schemes look like, and a half-implemented glob would be read as a full one.
 */
export function tagMatches(pattern: string, tag: string): boolean {
  return pattern.endsWith("*") ? tag.startsWith(pattern.slice(0, -1)) : tag === pattern;
}

/** Targets that deploy when a change lands on the default branch. */
export function targetsForMerge(targets: readonly DeployTarget[]): readonly DeployTarget[] {
  return targets.filter((target) => target.on === "merge");
}

/** Targets that deploy for a pushed tag, which arrives as `refs/tags/<name>`. */
export function targetsForTag(targets: readonly DeployTarget[], ref: string): readonly DeployTarget[] {
  const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : ref;
  return targets.filter((target) => target.on === "tag" && target.tags.some((p) => tagMatches(p, tag)));
}

/**
 * The target a dispatch named.
 *
 * A name that matches nothing returns undefined rather than falling back to
 * something: deploying a target the caller did not ask for is worse than not
 * deploying.
 */
export function targetByName(targets: readonly DeployTarget[], name: string): DeployTarget | undefined {
  return targets.find((target) => target.name === name);
}

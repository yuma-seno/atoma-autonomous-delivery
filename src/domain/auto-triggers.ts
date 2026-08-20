/**
 * auto-triggers.ts — validates `auto_triggers`, and says which of them an event
 * actually selects.
 *
 * `docs/customization.md` states the rule this module exists to keep, in the
 * section on merge gates:
 *
 *   **Mistakes are errors, not silence.** A misspelled condition, a pattern this
 *   matcher cannot honour, a gate with no conditions at all: each stops the merge
 *   and says why, instead of producing a gate that never fires.
 *
 * `auto_triggers` was the one list that did the opposite, and did it in the more
 * dangerous direction. `match_trigger.ts` asked "is the condition one I know, and
 * does it fail?" — so a condition it did not know was not a condition that never
 * fires, it was a trigger that fires **unconditionally**. A `non_draft` mistyped
 * as `nondraft` dispatched an agent onto every draft pull request, and the
 * config's author had every reason to believe the opposite.
 *
 * Same `{values, problems}` shape as `resolveMergeGates` and
 * `resolveDeployTargets`, and the same all-or-nothing rule: a list with any
 * problem resolves to no triggers at all. A partly-honoured trigger list is one
 * that dispatches some agents and silently not others.
 */
/**
 * One `auto_triggers` entry: an event, the agent it selects, and optionally a
 * condition narrowing when it applies.
 *
 * Defined here rather than in `lib/types.ts`, where it used to live, because
 * `domain/` may not import from `lib/` and the rules that give `condition` its
 * meaning are in this file. `AtomaConfig` imports it back.
 */
export interface AutoTrigger {
  event: string;
  agent: string;
  condition?: TriggerCondition;
}

/**
 * How a condition is answered.
 *
 * `runtime` conditions are evaluated per event from the workflow's own context.
 * `elsewhere` names the one condition that is deliberately never answered here:
 * `atoma:dispatch` marks the entry that documents the delivery system's own
 * comment marker, which `atoma-manual-comment.yml` parses directly out of the
 * comment body. It is a legitimate value and it must never select an agent from
 * this matcher.
 *
 * That distinction used to be carried by an unrelated accident. The shipped
 * config pairs `atoma:dispatch` with `agent: "$dispatch_agent"`, and the matcher
 * skips any agent beginning with `$` — so the entry was passed over for the
 * wrong reason, and writing the same condition beside a real agent name would
 * have dispatched on every comment.
 */
export type ConditionKind = "runtime" | "elsewhere";

/**
 * One entry per condition, carrying what it means.
 *
 * The `kind` and the matcher were separate: this record listed the legal names and
 * tagged them, and a `switch` elsewhere in the file re-listed the same names with the
 * behaviour. Nothing read the tag at all — so the record documented a distinction the
 * switch re-implemented by hand as `case "atoma:dispatch": return false`.
 *
 * Adding a fourth condition here and forgetting the switch arm was silent in the worst
 * direction: `resolveAutoTriggers` accepts the config, `applies` falls through to
 * `default: false`, and the trigger never fires. That is the failure this module's header
 * says it exists to prevent, pointing the other way from the bug it was written for.
 *
 * With the matcher in the entry there is no switch to forget, and a missing one is a type
 * error.
 */
interface ConditionSpec {
  kind: ConditionKind;
  /** Whether this condition holds for the event in hand. */
  matches: (context: TriggerContext) => boolean;
}

export const TRIGGER_CONDITIONS: Readonly<Record<string, ConditionSpec>> = {
  changes_requested: {
    kind: "runtime",
    matches: (context) => context.reviewState === "changes_requested",
  },
  non_draft: {
    kind: "runtime",
    matches: (context) => context.isDraft !== true,
  },
  "atoma:dispatch": {
    kind: "elsewhere",
    // Answered by `atoma-manual-comment.yml`, which reads the marker out of the comment
    // body. Never selects an agent here — which is what `elsewhere` means, now said once.
    matches: () => false,
  },
};

/** The condition names a config file may use, for messages and for the type. */
export type TriggerCondition = keyof typeof TRIGGER_CONDITIONS;

export interface AutoTriggerResolution {
  triggers: AutoTrigger[];
  problems: string[];
}

const KNOWN = Object.keys(TRIGGER_CONDITIONS).sort();

function readTrigger(raw: unknown, where: string, problems: string[]): AutoTrigger | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(`${where}: each entry must be an object with \`event\` and \`agent\`.`);
    return undefined;
  }
  const entry = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(entry).filter((key) => !["event", "agent", "condition"].includes(key));
  if (unknownKeys.length > 0) {
    problems.push(`${where}: unknown key(s) ${unknownKeys.join(", ")}; expected event, agent, condition.`);
  }

  if (typeof entry.event !== "string" || entry.event.trim() === "") {
    problems.push(`${where}: \`event\` must be a non-empty string, e.g. "pull_request.opened".`);
  }
  if (typeof entry.agent !== "string" || entry.agent.trim() === "") {
    problems.push(`${where}: \`agent\` must be a non-empty string.`);
  }

  if (entry.condition !== undefined) {
    if (typeof entry.condition !== "string") {
      problems.push(`${where}: \`condition\` must be a string; found ${JSON.stringify(entry.condition)}.`);
    } else if (!(entry.condition in TRIGGER_CONDITIONS)) {
      problems.push(
        `${where}: unknown condition "${entry.condition}". Known conditions are ${KNOWN.join(", ")}. ` +
          `An unrecognised condition used to be ignored, which made the trigger fire every time instead of never.`,
      );
    }
  }

  if (typeof entry.event !== "string" || typeof entry.agent !== "string") return undefined;
  return {
    event: entry.event,
    agent: entry.agent,
    ...(typeof entry.condition === "string" ? { condition: entry.condition as AutoTrigger["condition"] } : {}),
  };
}

/** Validate the whole list. Any problem resolves to no triggers. */
export function resolveAutoTriggers(raw: unknown): AutoTriggerResolution {
  if (raw === undefined) return { triggers: [], problems: [] };
  if (!Array.isArray(raw)) {
    return { triggers: [], problems: ["`auto_triggers` must be an array of {event, agent, condition?} objects."] };
  }

  const problems: string[] = [];
  const triggers: AutoTrigger[] = [];
  raw.forEach((entry, index) => {
    const trigger = readTrigger(entry, `auto_triggers[${index}]`, problems);
    if (trigger) triggers.push(trigger);
  });

  return problems.length > 0 ? { triggers: [], problems } : { triggers, problems };
}

/** What the workflow knows about the event being routed. */
export interface TriggerContext {
  /** `<event_name>.<action>`, e.g. `pull_request.synchronize`. */
  event: string;
  /** The review state, when this is a `pull_request_review` event. */
  reviewState?: string;
  /** Whether the pull request is a draft. */
  isDraft?: boolean;
}

/**
 * The agent this event selects, or "" for none.
 *
 * Reads as "does this entry apply?", not as "do I know a reason to skip it?" —
 * which is the inversion that made an unknown condition fire. By the time this
 * runs, `resolveAutoTriggers` has already rejected unknown conditions, so the
 * `default` arm below is unreachable through the normal path; it is written
 * anyway, and it refuses, because the safe answer to a condition nobody can
 * evaluate is not to dispatch an agent.
 */
export function selectTriggerAgent(triggers: readonly AutoTrigger[], context: TriggerContext): string {
  for (const trigger of triggers) {
    if (trigger.event !== context.event) continue;
    // `$`-prefixed agents are placeholders that document a path handled by
    // another workflow, never a name to dispatch.
    if (trigger.agent.startsWith("$")) continue;
    if (!applies(trigger.condition, context)) continue;
    return trigger.agent;
  }
  return "";
}

/**
 * Whether a trigger's condition holds.
 *
 * An absent condition applies always — that is what "no condition" means. An unknown one
 * never does, and cannot arrive here anyway: `resolveAutoTriggers` rejects it with a
 * problem naming the legal values, which is the whole reason this is not the place that
 * decides what is legal.
 */
function applies(condition: string | undefined, context: TriggerContext): boolean {
  if (condition === undefined) return true;
  return TRIGGER_CONDITIONS[condition]?.matches(context) ?? false;
}

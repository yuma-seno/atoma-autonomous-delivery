/**
 * config.ts — shared helper for reading .github/atoma/config.json. The one
 * canonical copy used by every script and MCP server in this repo.
 *
 * Resolved against `ATOMA_MACHINERY_ROOT` when that is set, and against the
 * working directory otherwise -- see `configPath()` for why a runner sets it.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_GOVERNED_PATHS } from "../domain/merge-readiness.ts";
import {
  resolveDeclaredSecrets,
  SECRET_DESTINATIONS,
  type SecretDestinationName,
  type SecretsResolution,
} from "../domain/declared-secrets.ts";
import { resolveDeployTargets, type DeployTargetsResolution } from "../domain/deploy-targets.ts";
import { resolveMergeGates, type MergeGatesResolution } from "../domain/merge-gates.ts";
import { resolveAutoTriggers } from "../domain/auto-triggers.ts";
import type { AtomaConfig } from "./types.ts";

/**
 * Where this project's configuration is read from.
 *
 * `ATOMA_MACHINERY_ROOT` is set by `atoma-runner` to a checkout of the default
 * branch, and unset everywhere else. The difference matters on a pull request
 * run: that workspace is the pull request's own head, so reading configuration
 * from it would let a pull request decide how the run reviewing it behaves --
 * which agent, which iteration budget, which commands, which credentials.
 *
 * Unset resolves to the working directory, which is what every other caller
 * wants and what this did before.
 */
function configPath(): string {
  const root = process.env.ATOMA_MACHINERY_ROOT?.trim();
  return root ? `${root}/.github/atoma/config.json` : ".github/atoma/config.json";
}

let cached: AtomaConfig | undefined;

/** Load and parse config.json (cached after first read within a process). */
export function loadConfig(): AtomaConfig {
  if (!cached) {
    cached = JSON.parse(readFileSync(configPath(), "utf8")) as AtomaConfig;
  }
  return cached;
}

/**
 * The label each key means when `config.json` does not say.
 *
 * One place, because a default written at the call site is written at every call site: the
 * sub-issue label's fallback appeared in `sibling-check.ts` and in `mcp/github.ts`, the
 * launched one in `sibling-check.ts` and `dispatch_sub_agent.ts`, the in-progress one in
 * two scripts. Change the writer's and not the reader's and `countOpenSiblings` filters on
 * a label nothing applies, so the sibling count never reaches zero and the parent is never
 * dispatched — with every run green.
 */
export const DEFAULT_LABELS = {
  sub_issue: "atoma/sub-issue",
  launched: "atoma/launched",
  in_progress: "atoma/in-progress",
} as const;

/** A label key that has a default. */
export type LabelKey = keyof typeof DEFAULT_LABELS;

/**
 * Look up a label from the top-level `labels` section of config.json.
 *
 * The fallback comes from [`DEFAULT_LABELS`] rather than from the caller, so two callers
 * asking for the same label cannot disagree about what it is called.
 */
export function getLabel(key: LabelKey): string {
  return loadConfig().labels?.[key] ?? DEFAULT_LABELS[key];
}

/** Look up the top-level `merge_policy` from config.json. */
export function getMergePolicy(fallback = "manual"): string {
  return loadConfig().merge_policy ?? fallback;
}

/**
 * Branch an issue's work starts from and targets, or "" for the default branch.
 *
 * Empty is deliberately the normal answer: callers pass it straight to `gh`,
 * which falls back to the repository's default branch on its own, so a project
 * that never sets this needs no special case anywhere.
 */
export function getBaseBranch(fallback = ""): string {
  // The one reader here that tolerates a MISSING config.json. No config means no
  // base branch, which is the same answer as a config without the key, so
  // `create_pr` should not start failing over a setting whose absence is the
  // normal case. The others deliberately still throw: defaulting a merge policy
  // or a label because a file could not be read would act on a guess.
  //
  // Narrowed to ENOENT, having been a bare `catch`. That caught a config.json
  // that exists and will not parse as well — the one case where every other
  // reader in this file throws, and where this one quietly aimed `create_pr` at
  // the default branch instead. "The file is not there" and "the file is broken"
  // are different facts and only the first is ordinary.
  try {
    return loadConfig().base_branch?.trim() || fallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/**
 * Default cross encoder for issue search.
 *
 * Multilingual, and chosen on measurement rather than on the language this
 * repository happens to be written in: on a Japanese corpus it reached 91% top-1
 * against 86% for the Japanese-specialised model it was compared with. A
 * multilingual default costs nothing here and is the only sensible default for
 * a template that ships to repositories in languages nobody here anticipated.
 *
 * This is the one model choice that changes the answer. Swapping the first
 * stage's model moved nothing; swapping this one moved top-1 from 27% to 91%.
 */
const DEFAULT_RERANKER = "onnx-community/bge-reranker-v2-m3-ONNX";

/**
 * The cross encoder issue search ranks with.
 *
 * Configurable because the default was picked by measuring one repository, and
 * a repository in another language — or one that would rather not download 600MB
 * on the first search — should be able to say so.
 */
export function getRerankerModel(): string {
  return loadConfig().search?.reranker_model?.trim() || DEFAULT_RERANKER;
}

/**
 * Paths whose change makes a merge a person's to perform.
 *
 * Configurable because "how agents run here" is not the same set of files in
 * every repository — one that keeps its workflows generated from source has a
 * second place to name. An empty array in config.json is a deliberate choice to
 * turn the gate off, and is honoured; an absent key takes the default.
 */
export function getGovernedPaths(): readonly string[] {
  return loadConfig().governed_paths ?? DEFAULT_GOVERNED_PATHS;
}

/**
 * This project's conditional merge gates, validated.
 *
 * Problems come back rather than throwing, like `getDeployTargets()`, because the
 * caller turns them into a blocker: a gate that cannot be read must stop the
 * merge, and a thrown error at this depth would surface as a tool failure that
 * loses the verdict instead of reporting it.
 */
export function getMergeGates(): MergeGatesResolution {
  return resolveMergeGates(loadConfig().merge_gates);
}

// `getTriggerAgent` was here: it read which agent an unconditional `auto_triggers`
// entry routed an event to, and had exactly one caller -- `dispatchPrValidation`,
// asking who reviews a pull request.
//
// That was the coupling #486 removed. Which agent reviews is now a parameter the
// caller passes, because opening a pull request no longer starts anyone by itself.
// Nothing else ever asked this question, so the function went with the trigger.

// No `getDeclaredSecrets()` here on purpose, though every other setting has a
// reader in this file.
//
// The credential declaration is read from the default branch by
// `read_secret_names.ts`, which loads that file itself and refuses to guess a
// path. A convenience wrapper here would be a second route to the same answer,
// and the next caller would find it first.
//
// `configPath()` above now sends every other setting to the default branch too on
// a runner, which makes the two consistent -- but not interchangeable. That one
// resolves a path it was handed; this one resolves one from the environment. The
// separation is what keeps a missing `ATOMA_MACHINERY_ROOT` from silently
// downgrading a credential decision to the working tree.

/**
 * Commands that verify a change, in order.
 *
 * Empty means this project runs nothing through `atoma-check.yml`, which is the
 * normal state for a repository pointing `workflows.ci` at its own workflow.
 */
export function getCheckCommands(): readonly string[] {
  return loadConfig().checks?.commands?.filter((command) => command.trim() !== "") ?? [];
}

/**
 * This project's deployments, validated.
 *
 * Problems come back rather than throwing so the deploy workflow can report all
 * of them at once and fail, instead of deploying the targets that happened to
 * parse.
 */
export function getDeployTargets(): DeployTargetsResolution {
  return resolveDeployTargets(loadConfig().deploy?.targets);
}

/**
 * Look up one of this project's own workflow names from the `workflows` section.
 *
 * Lives in config.json rather than in a repository variable because it is
 * project configuration: versioned, reviewable in a pull request, and one fewer
 * thing to remember when setting a repository up. That only works because
 * config.json is yours — the documented upgrade deliberately does not overwrite
 * it, unlike everything else under `.github/atoma/`.
 */
export function getWorkflowName(kind: "ci" | "cd", fallback = ""): string {
  return (loadConfig().workflows?.[kind] ?? "").trim() || fallback;
}

/**
 * How many agent handoffs may happen with nobody else commenting.
 *
 * Returned raw for `resolveHandoffLimit` to interpret, rather than defaulted here.
 * The domain module owns what an absent, zero or nonsense value means, and it owns
 * the default that the escalation comment quotes back to a person -- two places
 * deciding that is how the old limit's message came to name a number that was not
 * the limit.
 */
export function getHandoffLimit(): unknown {
  return loadConfig().limits?.agent_handoffs;
}

/**
 * How many times one piece of work may rebuild its environment.
 *
 * Raw, for `resolveReloadLimit` to interpret. The domain module owns what absent,
 * zero and nonsense mean, and it owns the default the refusal message quotes back
 * to the agent -- two places deciding that is how the old handoff limit came to
 * name a number that was not the limit.
 */
export function getReloadLimit(): unknown {
  return loadConfig().limits?.environment_reloads;
}

/**
 * The raw `runs_on` a project declared for one of the two jobs that run its own
 * commands, or undefined.
 *
 * Raw for `resolveRunsOn` to interpret, like every other limit and setting here:
 * the domain module owns what a bad value means and owns the default, so one
 * fallback exists rather than two that can disagree.
 */
export function getRunsOn(field: "checks" | "deploy"): unknown {
  const config = loadConfig();
  return field === "checks" ? config.checks?.runs_on : config.deploy?.runs_on;
}

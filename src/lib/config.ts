/**
 * config.ts — shared helper for reading .github/atoma/config.json. The one
 * canonical copy used by every script and MCP server in this repo.
 *
 * Assumes the current working directory is the repository root, matching
 * how every Atoma workflow step and MCP server invocation runs.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_GOVERNED_PATHS } from "../domain/merge-readiness.ts";
import { resolveToolSecrets, type ToolSecretsResolution } from "../domain/tool-secrets.ts";
import type { AtomaConfig } from "./types.ts";

const CONFIG_PATH = ".github/atoma/config.json";

let cached: AtomaConfig | undefined;

/** Load and parse config.json (cached after first read within a process). */
export function loadConfig(): AtomaConfig {
  if (!cached) {
    cached = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AtomaConfig;
  }
  return cached;
}

/** Look up a label from the top-level `labels` section of config.json. */
export function getLabel(key: string, fallback: string): string {
  return loadConfig().labels?.[key] ?? fallback;
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
  // The one reader here that tolerates a missing config.json. No config means no
  // base branch, which is the same answer as a config without the key, so
  // `create_pr` should not start failing over a setting whose absence is the
  // normal case. The others deliberately still throw: defaulting a merge policy
  // or a label because a file could not be read would act on a guess.
  try {
    return loadConfig().base_branch?.trim() || fallback;
  } catch {
    return fallback;
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
 * Look up the agent configured for an unconditional `auto_triggers` event.
 *
 * Entries with a `condition` (e.g. changes_requested) are evaluated by
 * match_trigger.ts at workflow time, not here, so they're skipped -- this is
 * only for simple event->agent lookups like "who reviews a newly opened PR".
 */
export function getTriggerAgent(event: string, fallback = ""): string {
  for (const trigger of loadConfig().auto_triggers ?? []) {
    if (trigger.event === event && !trigger.condition) {
      return trigger.agent || fallback;
    }
  }
  return fallback;
}

/**
 * Repository secrets this project lets a run hand to the agent.
 *
 * Returns the validated names and every problem found with the declaration; the
 * caller decides what a problem means. `read_tool_secret_names.ts` fails the run
 * on one, because a credential that was asked for and silently not delivered
 * surfaces as an unrelated tool failure much later.
 */
export function getToolSecrets(): ToolSecretsResolution {
  return resolveToolSecrets(loadConfig().tools?.secrets);
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

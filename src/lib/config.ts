/**
 * config.ts — shared helper for reading .github/atoma/config.json. The one
 * canonical copy used by every script and MCP server in this repo.
 *
 * Assumes the current working directory is the repository root, matching
 * how every Atoma workflow step and MCP server invocation runs.
 */
import { readFileSync } from "node:fs";
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

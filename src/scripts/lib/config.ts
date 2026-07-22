/**
 * config.ts — shared helper for reading .github/atoma/config.json.
 *
 * Assumes the current working directory is the repository root, matching how
 * all Atoma workflow steps invoke these scripts.
 *
 * Self-contained: do not import anything outside `.github/`.
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

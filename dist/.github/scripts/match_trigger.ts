#!/usr/bin/env bun
/**
 * match_trigger.ts — Match a GitHub event to an agent from config.json
 * auto_triggers.
 */
import { loadConfig } from "./lib/config.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

/** Env-var contract for this script, used by callers to build a type-checked `env:` block. */
export interface MatchTriggerEnv {
  EVENT_TYPE?: string;
  REVIEW_STATE?: string;
  IS_DRAFT?: string;
}

function main(): void {
  const env = process.env;
  let event = env.EVENT_TYPE ?? "";
  // Normalize pull_request_target to pull_request (config.json uses pull_request.*)
  if (event.startsWith("pull_request_target.")) {
    event = "pull_request." + event.slice("pull_request_target.".length);
  }
  const reviewState = env.REVIEW_STATE ?? "";
  const isDraft = env.IS_DRAFT ?? "";

  const config = loadConfig();

  for (const trigger of config.auto_triggers ?? []) {
    if (trigger.event !== event) continue;
    if (trigger.condition === "changes_requested" && reviewState !== "changes_requested") continue;
    if (trigger.condition === "non_draft" && isDraft === "true") continue;
    const agent = trigger.agent;
    if (agent.startsWith("$")) continue;
    console.log(agent);
    return;
  }
}

if (import.meta.main) main();

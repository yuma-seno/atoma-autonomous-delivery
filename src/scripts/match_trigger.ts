#!/usr/bin/env bun
/**
 * match_trigger.ts — Match a GitHub event to an agent from config.json
 * auto_triggers.
 *
 * Two steps, deliberately separated. `resolveAutoTriggers` decides whether the
 * configuration is usable at all, and `selectTriggerAgent` decides which entry
 * this event selects. Both live in `domain/auto-triggers.ts`; this script is the
 * part that reads the environment and prints.
 *
 * The matching used to be four lines here, and they were inverted: they asked
 * "do I know a reason to skip this entry?" rather than "does this entry apply?".
 * A condition the script did not recognise was therefore not a trigger that never
 * fires, it was a trigger that fires every time.
 */
import { loadConfig } from "../lib/config.ts";
import { resolveAutoTriggers, selectTriggerAgent } from "../domain/auto-triggers.ts";
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

  const { triggers, problems } = resolveAutoTriggers(loadConfig().auto_triggers);
  if (problems.length > 0) {
    // Fails the step rather than dispatching nobody quietly. An unusable trigger
    // list and an event nothing matches produce the same silence otherwise, and
    // only one of them is a repository that has stopped responding to its own
    // pull requests.
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }

  const agent = selectTriggerAgent(triggers, {
    event,
    reviewState: env.REVIEW_STATE ?? "",
    isDraft: (env.IS_DRAFT ?? "") === "true",
  });
  if (agent) console.log(agent);
}

if (import.meta.main) main();

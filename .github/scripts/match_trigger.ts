#!/usr/bin/env bun
// @bun

// src/lib/config.ts
import { readFileSync } from "fs";

// src/domain/merge-readiness.ts
var CI_WOULD_BE_WASTED = new Set([
  "not-open",
  "draft",
  "conflicting",
  "behind",
  "mergeability-unknown",
  "checks-pending",
  "checks-failing"
]);
var PASSING = new Set(["success", "neutral", "skipped"]);

// src/domain/auto-triggers.ts
var TRIGGER_CONDITIONS = {
  changes_requested: {
    kind: "runtime",
    matches: (context) => context.reviewState === "changes_requested"
  },
  non_draft: {
    kind: "runtime",
    matches: (context) => context.isDraft !== true
  },
  "atoma:dispatch": {
    kind: "elsewhere",
    matches: () => false
  }
};
var KNOWN = Object.keys(TRIGGER_CONDITIONS).sort();
function readTrigger(raw, where, problems) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(`${where}: each entry must be an object with \`event\` and \`agent\`.`);
    return;
  }
  const entry = raw;
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
      problems.push(`${where}: unknown condition "${entry.condition}". Known conditions are ${KNOWN.join(", ")}. ` + `An unrecognised condition used to be ignored, which made the trigger fire every time instead of never.`);
    }
  }
  if (typeof entry.event !== "string" || typeof entry.agent !== "string")
    return;
  return {
    event: entry.event,
    agent: entry.agent,
    ...typeof entry.condition === "string" ? { condition: entry.condition } : {}
  };
}
function resolveAutoTriggers(raw) {
  if (raw === undefined)
    return { triggers: [], problems: [] };
  if (!Array.isArray(raw)) {
    return { triggers: [], problems: ["`auto_triggers` must be an array of {event, agent, condition?} objects."] };
  }
  const problems = [];
  const triggers = [];
  raw.forEach((entry, index) => {
    const trigger = readTrigger(entry, `auto_triggers[${index}]`, problems);
    if (trigger)
      triggers.push(trigger);
  });
  return problems.length > 0 ? { triggers: [], problems } : { triggers, problems };
}
function selectTriggerAgent(triggers, context) {
  for (const trigger of triggers) {
    if (trigger.event !== context.event)
      continue;
    if (trigger.agent.startsWith("$"))
      continue;
    if (!applies(trigger.condition, context))
      continue;
    return trigger.agent;
  }
  return "";
}
function applies(condition, context) {
  if (condition === undefined)
    return true;
  return TRIGGER_CONDITIONS[condition]?.matches(context) ?? false;
}

// src/lib/config.ts
function configPath() {
  const root = process.env.ATOMA_MACHINERY_ROOT?.trim();
  return root ? `${root}/.github/atoma/config.json` : ".github/atoma/config.json";
}
var cached;
function loadConfig() {
  if (!cached) {
    cached = JSON.parse(readFileSync(configPath(), "utf8"));
  }
  return cached;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/match_trigger.ts
var ref = defineScript(import.meta.url);
function main() {
  const env = process.env;
  let event = env.EVENT_TYPE ?? "";
  if (event.startsWith("pull_request_target.")) {
    event = "pull_request." + event.slice("pull_request_target.".length);
  }
  const { triggers, problems } = resolveAutoTriggers(loadConfig().auto_triggers);
  if (problems.length > 0) {
    for (const problem of problems)
      console.error(`::error::${problem}`);
    process.exit(1);
  }
  const agent = selectTriggerAgent(triggers, {
    event,
    reviewState: env.REVIEW_STATE ?? "",
    isDraft: (env.IS_DRAFT ?? "") === "true"
  });
  if (agent)
    console.log(agent);
}
if (import.meta.main)
  main();
export {
  ref
};

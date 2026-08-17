#!/usr/bin/env bun
// @bun

// src/lib/config.ts
import { readFileSync } from "fs";

// src/domain/merge-readiness.ts
var PASSING = new Set(["success", "neutral", "skipped"]);

// src/lib/config.ts
var CONFIG_PATH = ".github/atoma/config.json";
var cached;
function loadConfig() {
  if (!cached) {
    cached = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
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
  const reviewState = env.REVIEW_STATE ?? "";
  const isDraft = env.IS_DRAFT ?? "";
  const config = loadConfig();
  for (const trigger of config.auto_triggers ?? []) {
    if (trigger.event !== event)
      continue;
    if (trigger.condition === "changes_requested" && reviewState !== "changes_requested")
      continue;
    if (trigger.condition === "non_draft" && isDraft === "true")
      continue;
    const agent = trigger.agent;
    if (agent.startsWith("$"))
      continue;
    console.log(agent);
    return;
  }
}
if (import.meta.main)
  main();
export {
  ref
};

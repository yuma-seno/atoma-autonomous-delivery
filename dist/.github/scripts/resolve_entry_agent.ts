#!/usr/bin/env bun
// @bun

// src/scripts/resolve_entry_agent.ts
import { readFileSync, appendFileSync } from "fs";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/resolve_entry_agent.ts
var ref = defineScript(import.meta.url);
function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const number = process.env.NUMBER ?? "";
  const sender = process.env.SENDER ?? "";
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (!eventPath) {
    console.error("resolve_entry_agent: GITHUB_EVENT_PATH is not set");
    return;
  }
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const body = event.issue?.body ?? "";
  const firstLine = (body.trim().split(`
`)[0] ?? "").trim();
  if (!firstLine.startsWith("/"))
    return;
  const agent = firstLine.slice(1).trim();
  if (!agent)
    return;
  if (githubOutput) {
    appendFileSync(githubOutput, [`agent=${agent}`, `number=${number}`, "type=issue", `notify=${sender}`].join(`
`) + `
`);
  }
}
if (import.meta.main)
  main();
export {
  ref
};

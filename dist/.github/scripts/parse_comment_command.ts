#!/usr/bin/env bun
// @bun

// src/scripts/parse_comment_command.ts
import { appendFileSync } from "fs";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/parse_comment_command.ts
var ref = defineScript(import.meta.url);
var COMMAND_RE = /^\/([a-z][a-z0-9-]*)/;
var DISPATCH_RE = /^<!--\s*atoma:dispatch\s*=\s*([a-z][a-z0-9-]*)\s*-->/;
function parseAgent(body) {
  if (!body)
    return "";
  for (const rawLine of body.split(`
`)) {
    const line = rawLine.trim();
    const commandMatch = COMMAND_RE.exec(line);
    if (commandMatch)
      return commandMatch[1];
    const dispatchMatch = DISPATCH_RE.exec(line);
    if (dispatchMatch)
      return dispatchMatch[1];
  }
  return "";
}
function main() {
  const body = process.env.ATOMA_COMMENT_BODY ?? "";
  const agent = parseAgent(body);
  const matched = agent ? "true" : "false";
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `matched=${matched}
agent=${agent}
`);
  }
}
if (import.meta.main)
  main();
export {
  ref,
  parseAgent
};

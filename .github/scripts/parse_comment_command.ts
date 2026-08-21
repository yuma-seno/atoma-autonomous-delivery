#!/usr/bin/env bun
// @bun

// src/scripts/parse_comment_command.ts
import { appendFileSync } from "fs";

// src/lib/agent-name.ts
var AGENT_NAME_PATTERN = "[a-z][a-z0-9-]*";
var AGENT_NAME_RE = new RegExp(`^${AGENT_NAME_PATTERN}$`);

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/parse_comment_command.ts
var ref = defineScript(import.meta.url);
var COMMAND_RE = new RegExp(`^\\/(${AGENT_NAME_PATTERN})(?:\\s+(.*))?$`);
var DISPATCH_RE = new RegExp(`^<!--\\s*atoma:dispatch\\s*=\\s*(${AGENT_NAME_PATTERN})\\s*-->`);
function parseCommentCommand(body) {
  if (!body)
    return { agent: "", sessionMode: "continue", error: "" };
  for (const rawLine of body.split(`
`)) {
    const line = rawLine.trim();
    const commandMatch = COMMAND_RE.exec(line);
    if (commandMatch) {
      const agent = commandMatch[1];
      const modifier = commandMatch[2]?.trim() ?? "";
      if (!modifier)
        return { agent, sessionMode: "continue", error: "" };
      if (modifier === "recover")
        return { agent, sessionMode: "recover", error: "" };
      return {
        agent: "",
        sessionMode: "continue",
        error: `Unknown command syntax: '/${agent} ${modifier}'. Put instructions on the lines after '/${agent}', or use '/${agent} recover'.`
      };
    }
    const dispatchMatch = DISPATCH_RE.exec(line);
    if (dispatchMatch)
      return { agent: dispatchMatch[1], sessionMode: "continue", error: "" };
  }
  return { agent: "", sessionMode: "continue", error: "" };
}
function main() {
  const body = process.env.ATOMA_COMMENT_BODY ?? "";
  const { agent, sessionMode, error } = parseCommentCommand(body);
  const matched = agent ? "true" : "false";
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `matched=${matched}
agent=${agent}
`);
    appendFileSync(githubOutput, `session_mode=${sessionMode}
error=${error}
`);
  }
}
if (import.meta.main)
  main();
export {
  parseCommentCommand,
  ref
};

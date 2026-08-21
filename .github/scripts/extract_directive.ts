#!/usr/bin/env bun
// @bun

// src/scripts/extract_directive.ts
import { existsSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";

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

// src/scripts/extract_directive.ts
var ref = defineScript(import.meta.url);
var COMMAND_RE = new RegExp(`^\\/(${AGENT_NAME_PATTERN})$`);
function candidates(rawLine) {
  let line = rawLine.trim();
  if (!line)
    return [];
  line = line.replace(/^(?:[-*+]\s+|>\s*)+/, "");
  const variants = [line];
  if (line.startsWith("`") && line.endsWith("`") && line.length > 2) {
    variants.push(line.slice(1, -1).trim());
  }
  if (line.startsWith("/`") && line.endsWith("`") && line.length > 3) {
    variants.push("/" + line.slice(2, -1).trim());
  }
  return variants;
}
function extractDirective(output, defDir) {
  for (const rawLine of output.split(`
`)) {
    for (const candidate of candidates(rawLine)) {
      const match = COMMAND_RE.exec(candidate);
      if (match) {
        const agent = match[1];
        if (existsSync(join(defDir, `${agent}.md`)))
          return agent;
      }
    }
  }
  return "";
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "output-file": { type: "string" },
      "def-dir": { type: "string" }
    }
  });
  if (!values["output-file"] || !values["def-dir"]) {
    console.error("usage: extract_directive.ts --output-file FILE --def-dir DIR");
    process.exit(2);
  }
  const output = existsSync(values["output-file"]) ? readFileSync(values["output-file"], "utf8") : "";
  const directive = extractDirective(output, values["def-dir"]);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput)
    appendFileSync(githubOutput, `directive=${directive}
`);
}
if (import.meta.main)
  main();
export {
  extractDirective,
  ref
};

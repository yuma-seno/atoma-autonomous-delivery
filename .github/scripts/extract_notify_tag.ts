#!/usr/bin/env bun
// @bun

// src/scripts/extract_notify_tag.ts
import { appendFileSync } from "fs";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/extract_notify_tag.ts
var ref = defineScript(import.meta.url);
var NOTIFY_RE = /<!--\s*atoma:notify=([A-Za-z0-9-]+)\s*-->/;
function main() {
  const body = process.env.PR_BODY ?? "";
  const notify = NOTIFY_RE.exec(body)?.[1] ?? "";
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput)
    appendFileSync(githubOutput, `notify=${notify}
`);
}
if (import.meta.main)
  main();
export {
  ref
};

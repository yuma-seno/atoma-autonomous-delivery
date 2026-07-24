#!/usr/bin/env bun
// @bun

// src/scripts/parse_pr_metadata.ts
import { appendFileSync } from "fs";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/parse_pr_metadata.ts
var ref = defineScript(import.meta.url);
function main() {
  const body = process.env.PR_BODY ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const githubOutput = process.env.GITHUB_OUTPUT;
  const parent = /<!--\s*atoma:parent-issue=(\d+)\s*-->/.exec(body)?.[1] ?? "";
  if (parent)
    console.error(`PR #${prNumber} is linked to parent issue #${parent}`);
  else
    console.error(`PR #${prNumber} has no parent-issue metadata`);
  const sub = /Closes #(\d+)/.exec(body)?.[1] ?? "";
  if (sub)
    console.error(`PR closes sub-issue #${sub}`);
  if (githubOutput) {
    appendFileSync(githubOutput, `parent_number=${parent}
sub_number=${sub}
`);
  }
}
if (import.meta.main)
  main();
export {
  ref
};

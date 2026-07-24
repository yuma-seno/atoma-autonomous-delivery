#!/usr/bin/env bun
// @bun

// src/scripts/notify_max_iterations.ts
import { parseArgs } from "util";

// src/lib/gh.ts
function run(cmd) {
  const proc = Bun.spawnSync({
    cmd,
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "",
    stderr: proc.stderr ? proc.stderr.toString("utf8").trim() : ""
  };
}
function gh(...args) {
  return run(["gh", ...args]);
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/notify_max_iterations.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      agent: { type: "string" },
      notify: { type: "string" }
    }
  });
  if (!values.number || !values.agent) {
    console.error("usage: notify_max_iterations.ts --number N --agent AGENT [--notify LOGIN]");
    process.exit(2);
  }
  const body = values.notify ? `@${values.notify} Atoma: \`${values.agent}\` reached the max iteration limit. Review the issue and comment \`/${values.agent}\` to retry.` : `Atoma: \`${values.agent}\` reached the max iteration limit. Comment \`/${values.agent}\` to retry.`;
  gh("issue", "comment", values.number, "--body", body);
}
if (import.meta.main)
  main();
export {
  ref
};

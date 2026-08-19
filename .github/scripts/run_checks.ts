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
  changes_requested: "runtime",
  non_draft: "runtime",
  "atoma:dispatch": "elsewhere"
};
var KNOWN = Object.keys(TRIGGER_CONDITIONS).sort();

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
function getCheckCommands() {
  return loadConfig().checks?.commands?.filter((command) => command.trim() !== "") ?? [];
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/run_checks.ts
var ref = defineScript(import.meta.url);
function main() {
  const commands = getCheckCommands();
  if (commands.length === 0) {
    console.log("::warning::This check verified nothing: `checks.commands` in .github/atoma/config.json is empty, so a pull request satisfying it has not been tested. Add the commands that check this project, or point `workflows.ci` at a workflow of your own.");
    return;
  }
  console.log(`Running ${commands.length} check command(s).`);
  for (const command of commands) {
    console.log(`::group::${command}`);
    const result = Bun.spawnSync({ cmd: ["bash", "-c", command], stdout: "inherit", stderr: "inherit" });
    console.log("::endgroup::");
    if (result.exitCode !== 0) {
      console.error(`::error::Check failed (exit ${result.exitCode}): ${command}`);
      process.exit(result.exitCode ?? 1);
    }
  }
  console.log("All checks passed.");
}
if (import.meta.main)
  main();
export {
  ref
};

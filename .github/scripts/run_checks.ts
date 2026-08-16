#!/usr/bin/env bun
// @bun

// src/lib/config.ts
import { readFileSync } from "fs";

// src/domain/merge-readiness.ts
var PASSING = new Set(["success", "neutral", "skipped"]);

// src/domain/declared-secrets.ts
var TOOL_SECRETS = {
  field: "tools.secrets",
  reserved: new Set([
    "AGENT",
    "ANTHROPIC_API_KEY",
    "ATOMA_OPS_LOG",
    "ATOMA_PROVIDER",
    "ATOMA_RUN_TYPE",
    "GH_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "GITHUB_RUN_ID",
    "ISSUE_NOTIFY",
    "ISSUE_NUMBER",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL"
  ])
};
var CHECK_SECRETS = {
  field: "checks.secrets",
  reserved: new Set(["GH_TOKEN"])
};
var DEPLOY_SECRETS = {
  field: "deploy.secrets",
  reserved: new Set(["ATOMA_DEPLOY_TARGET", "GH_TOKEN"])
};

// src/lib/config.ts
var CONFIG_PATH = ".github/atoma/config.json";
var cached;
function loadConfig() {
  if (!cached) {
    cached = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
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

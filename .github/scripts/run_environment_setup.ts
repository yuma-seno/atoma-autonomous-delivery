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

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/run_environment_setup.ts
var ref = defineScript(import.meta.url);
function main() {
  const commands = loadConfig().environment?.setup_commands ?? [];
  if (commands.length === 0) {
    console.log("No environment.setup_commands configured; skipping.");
    return;
  }
  for (const cmd of commands) {
    console.log(`Running environment setup command: ${cmd}`);
    const result = Bun.spawnSync({ cmd: ["bash", "-c", cmd], stdout: "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) {
      console.error(`environment setup command failed (exit ${result.exitCode}): ${cmd}`);
      process.exit(result.exitCode ?? 1);
    }
  }
}
if (import.meta.main)
  main();
export {
  ref
};

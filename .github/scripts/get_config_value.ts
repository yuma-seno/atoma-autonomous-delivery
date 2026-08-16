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

// src/scripts/get_config_value.ts
var ref = defineScript(import.meta.url);
function buildArgv(path, fallback) {
  return fallback === undefined ? [`"${path}"`] : [`"${path}"`, `"${fallback}"`];
}
function main() {
  const [path, fallback = ""] = Bun.argv.slice(2);
  if (!path) {
    console.error("usage: get_config_value.ts <dotted.path> [default]");
    process.exit(2);
  }
  let node = loadConfig();
  for (const key of path.split(".")) {
    if (node && typeof node === "object" && key in node) {
      node = node[key];
    } else {
      console.log(fallback);
      return;
    }
  }
  console.log(node);
}
if (import.meta.main)
  main();
export {
  ref,
  buildArgv
};

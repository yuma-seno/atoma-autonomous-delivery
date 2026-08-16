#!/usr/bin/env bun
// @bun

// src/scripts/manage_in_progress_label.ts
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
function getLabel(key, fallback) {
  return loadConfig().labels?.[key] ?? fallback;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/manage_in_progress_label.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      action: { type: "string" },
      number: { type: "string" }
    }
  });
  if (values.action !== "add" && values.action !== "remove") {
    console.error("usage: manage_in_progress_label.ts --action add|remove --number N");
    process.exit(2);
  }
  if (!values.number) {
    console.error("usage: manage_in_progress_label.ts --action add|remove --number N");
    process.exit(2);
  }
  const label = getLabel("in_progress", "atoma/in-progress");
  if (values.action === "add") {
    gh("label", "create", label, "--force", "-c", "0366d6", "-d", "Issue is being worked on by an Atoma agent");
    const { code } = gh("issue", "edit", values.number, "--add-label", label);
    if (code !== 0)
      console.error(`Warning: failed to add '${label}' label to #${values.number}`);
  } else {
    const { code } = gh("issue", "edit", values.number, "--remove-label", label);
    if (code !== 0)
      console.error(`Warning: failed to remove '${label}' label from #${values.number}`);
  }
}
if (import.meta.main)
  main();
export {
  ref
};

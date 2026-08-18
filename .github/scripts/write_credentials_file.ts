#!/usr/bin/env bun
// @bun

// src/scripts/write_credentials_file.ts
import { writeFileSync } from "fs";
import { parseArgs } from "util";

// src/domain/declared-secrets.ts
var SECRET_SLOTS = 10;
var SECRET_SLOT_PREFIX = "ATOMA_SECRET_";
var SECRET_NAMES_VAR = "ATOMA_SECRET_NAMES";
var RUN_CREDENTIALS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ATOMA_COPILOT_TOKEN",
  "GH_TOKEN"
];
var TOOL_SECRETS = {
  field: "tools.secrets",
  reserved: new Set([
    ...RUN_CREDENTIALS,
    "AGENT",
    "ATOMA_OPS_LOG",
    "ATOMA_PROVIDER",
    "ATOMA_RUN_TYPE",
    "GITHUB_RUN_ID",
    "ISSUE_NOTIFY",
    "ISSUE_NUMBER",
    "OPENAI_BASE_URL",
    "ATOMA_PROVIDER_IN",
    "OPENAI_BASE_URL_IN"
  ])
};
var CHECK_SECRETS = {
  field: "checks.secrets",
  reserved: new Set(["GH_TOKEN"])
};
var DEPLOY_SECRETS = {
  field: "deploy.secrets",
  reserved: new Set([
    "ATOMA_DEPLOY_REF",
    "ATOMA_DEPLOY_TARGET",
    "ATOMA_DEPLOY_TARGET_INPUT",
    "ATOMA_DEPLOY_TRIGGER",
    "GH_TOKEN"
  ])
};

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/write_credentials_file.ts
var ref = defineScript(import.meta.url);
function collect(env) {
  const out = {};
  for (const name of RUN_CREDENTIALS) {
    const value = env[name];
    if (value)
      out[name] = value;
  }
  let declared = [];
  try {
    declared = JSON.parse(env[SECRET_NAMES_VAR] || "[]");
  } catch {
    console.error(`::warning::${SECRET_NAMES_VAR} was not valid JSON; no declared credentials will be written.`);
  }
  declared.slice(0, SECRET_SLOTS).forEach((name, slot) => {
    const value = env[`${SECRET_SLOT_PREFIX}${slot}`];
    if (value)
      out[name] = value;
    else {
      console.error(`::warning::config.json declares ${name}, but this repository has no secret by that name. Whatever needs it will fail.`);
    }
  });
  return out;
}
function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { out: { type: "string" } } });
  if (!values.out) {
    console.error("usage: write_credentials_file.ts --out FILE");
    process.exit(2);
  }
  const credentials = collect(process.env);
  writeFileSync(values.out, JSON.stringify(credentials), { mode: 384 });
  console.error(`Wrote ${Object.keys(credentials).length} credential(s) for this run: ${Object.keys(credentials).join(", ")}`);
}
if (import.meta.main)
  main();
export {
  ref,
  collect
};

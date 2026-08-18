#!/usr/bin/env bun
// @bun

// src/scripts/read_secret_names.ts
import { appendFileSync, readFileSync } from "fs";
import { parseArgs } from "util";

// src/domain/declared-secrets.ts
var SECRET_SLOTS = 10;
var SECRET_SLOT_PREFIX = "ATOMA_SECRET_";
var NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
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
var SECRET_DESTINATIONS = {
  tools: TOOL_SECRETS,
  checks: CHECK_SECRETS,
  deploy: DEPLOY_SECRETS
};
function isSecretDestinationName(value) {
  return Object.hasOwn(SECRET_DESTINATIONS, value);
}
function resolveDeclaredSecrets(raw, destination) {
  const { field, reserved } = destination;
  if (raw === undefined || raw === null)
    return { names: [], problems: [] };
  if (!Array.isArray(raw)) {
    return { names: [], problems: [`\`${field}\` must be an array of secret names.`] };
  }
  const problems = [];
  const names = [];
  const seen = new Set;
  for (const entry of raw) {
    if (typeof entry !== "string") {
      problems.push(`\`${field}\` entries must be strings; found ${JSON.stringify(entry)}.`);
      continue;
    }
    const name = entry.trim();
    if (!NAME_PATTERN.test(name)) {
      problems.push(`\`${field}\`: '${name}' is not a usable secret name. Expected uppercase letters, digits and underscores, starting with a letter \u2014 e.g. 'SLACK_TOKEN'.`);
      continue;
    }
    if (reserved.has(name)) {
      problems.push(`\`${field}\`: '${name}' is already part of the environment this workflow provides, so declaring it would replace that value rather than add a credential. Give the secret another name.`);
      continue;
    }
    if (name.startsWith(SECRET_SLOT_PREFIX)) {
      problems.push(`\`${field}\`: '${name}' collides with the slots this mechanism uses internally. Give the secret another name.`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`\`${field}\`: '${name}' is declared more than once.`);
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  if (names.length > SECRET_SLOTS) {
    problems.push(`\`${field}\` declares ${names.length} secrets but a run carries at most ${SECRET_SLOTS}. Raising the cap needs a new release, since each slot is a line of generated workflow YAML.`);
  }
  return problems.length > 0 ? { names: [], problems } : { names, problems };
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/read_secret_names.ts
var ref = defineScript(import.meta.url);
function declarationIn(configText, destination) {
  const config = JSON.parse(configText);
  return { tools: config.tools, checks: config.checks, deploy: config.deploy }[destination]?.secrets;
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { destination: { type: "string" }, config: { type: "string" } }
  });
  const destination = values.destination ?? "";
  if (!isSecretDestinationName(destination)) {
    console.error(`::error::read_secret_names: unknown destination '${destination}'.`);
    process.exit(2);
  }
  let declared;
  if (!values.config) {
    console.error("::warning::read_secret_names: no --config given, so no credentials are declared for this run. The workflow should pass the default branch's config.json.");
  } else {
    try {
      declared = declarationIn(readFileSync(values.config, "utf8"), destination);
    } catch (error) {
      console.error(`No credential declaration could be read (${error.message}); declaring none.`);
    }
  }
  const { names, problems } = resolveDeclaredSecrets(declared, SECRET_DESTINATIONS[destination]);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::.github/atoma/config.json: ${problem}`);
    }
    process.exit(1);
  }
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `names=${JSON.stringify(names)}
`);
  }
  console.error(names.length > 0 ? `Secrets declared for ${destination}: ${names.join(", ")}` : `No secrets declared for ${destination}.`);
}
if (import.meta.main)
  main();
export {
  ref,
  declarationIn
};

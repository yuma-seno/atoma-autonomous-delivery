#!/usr/bin/env bun
// @bun

// src/scripts/validate_deliverable.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";

// src/domain/auto-triggers.ts
var TRIGGER_CONDITIONS = {
  changes_requested: {
    kind: "runtime",
    matches: (context) => context.reviewState === "changes_requested"
  },
  non_draft: {
    kind: "runtime",
    matches: (context) => context.isDraft !== true
  },
  "atoma:dispatch": {
    kind: "elsewhere",
    matches: () => false
  }
};
var KNOWN = Object.keys(TRIGGER_CONDITIONS).sort();
function readTrigger(raw, where, problems) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    problems.push(`${where}: each entry must be an object with \`event\` and \`agent\`.`);
    return;
  }
  const entry = raw;
  const unknownKeys = Object.keys(entry).filter((key) => !["event", "agent", "condition"].includes(key));
  if (unknownKeys.length > 0) {
    problems.push(`${where}: unknown key(s) ${unknownKeys.join(", ")}; expected event, agent, condition.`);
  }
  if (typeof entry.event !== "string" || entry.event.trim() === "") {
    problems.push(`${where}: \`event\` must be a non-empty string, e.g. "pull_request.opened".`);
  }
  if (typeof entry.agent !== "string" || entry.agent.trim() === "") {
    problems.push(`${where}: \`agent\` must be a non-empty string.`);
  }
  if (entry.condition !== undefined) {
    if (typeof entry.condition !== "string") {
      problems.push(`${where}: \`condition\` must be a string; found ${JSON.stringify(entry.condition)}.`);
    } else if (!(entry.condition in TRIGGER_CONDITIONS)) {
      problems.push(`${where}: unknown condition "${entry.condition}". Known conditions are ${KNOWN.join(", ")}. ` + `An unrecognised condition used to be ignored, which made the trigger fire every time instead of never.`);
    }
  }
  if (typeof entry.event !== "string" || typeof entry.agent !== "string")
    return;
  return {
    event: entry.event,
    agent: entry.agent,
    ...typeof entry.condition === "string" ? { condition: entry.condition } : {}
  };
}
function resolveAutoTriggers(raw) {
  if (raw === undefined)
    return { triggers: [], problems: [] };
  if (!Array.isArray(raw)) {
    return { triggers: [], problems: ["`auto_triggers` must be an array of {event, agent, condition?} objects."] };
  }
  const problems = [];
  const triggers = [];
  raw.forEach((entry, index) => {
    const trigger = readTrigger(entry, `auto_triggers[${index}]`, problems);
    if (trigger)
      triggers.push(trigger);
  });
  return problems.length > 0 ? { triggers: [], problems } : { triggers, problems };
}

// src/domain/declared-secrets.ts
var SECRET_SLOTS = 10;
var SECRET_SLOT_PREFIX = "ATOMA_SECRET_";
var NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
var RUN_CREDENTIALS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ORCAROUTER_API_KEY",
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
    "ATOMA_RELOAD_COUNT",
    "ATOMA_RUN_TYPE",
    "GITHUB_RUN_ID",
    "ISSUE_NOTIFY",
    "ISSUE_NUMBER",
    "OPENAI_BASE_URL",
    "OPENROUTER_BASE_URL",
    "ORCAROUTER_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "COPILOT_BASE_URL",
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

// src/domain/deploy-targets.ts
var TRIGGERS = ["merge", "tag", "manual"];
var NAME_PATTERN2 = /^[a-z][a-z0-9-]*$/;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readCommands(raw, where, problems) {
  const before = problems.length;
  if (!Array.isArray(raw)) {
    problems.push(`${where}: \`commands\` must be an array of shell commands.`);
    return [];
  }
  const commands = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      problems.push(`${where}: every command must be a non-empty string; found ${JSON.stringify(entry)}.`);
      continue;
    }
    commands.push(entry);
  }
  if (commands.length === 0 && problems.length === before) {
    problems.push(`${where}: declares no commands, so it would deploy nothing.`);
  }
  return commands;
}
function resolveDeployTargets(raw) {
  if (raw === undefined || raw === null)
    return { targets: [], problems: [] };
  if (!Array.isArray(raw)) {
    return { targets: [], problems: ["`deploy.targets` must be an array."] };
  }
  const problems = [];
  const targets = [];
  const seen = new Set;
  raw.forEach((entry, index) => {
    const where = `\`deploy.targets[${index}]\``;
    if (!isRecord(entry)) {
      problems.push(`${where} must be an object.`);
      return;
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!NAME_PATTERN2.test(name)) {
      problems.push(`${where}: \`name\` must be lowercase letters, digits and hyphens \u2014 e.g. 'production'.`);
      return;
    }
    if (seen.has(name)) {
      problems.push(`${where}: '${name}' is declared more than once.`);
      return;
    }
    const on = entry.on;
    if (typeof on !== "string" || !TRIGGERS.includes(on)) {
      problems.push(`${where}: \`on\` must be one of ${TRIGGERS.map((t) => `'${t}'`).join(", ")}.`);
      return;
    }
    const trigger = on;
    const tagsRaw = entry.tags ?? [];
    if (!Array.isArray(tagsRaw) || tagsRaw.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
      problems.push(`${where}: \`tags\` must be an array of non-empty patterns.`);
      return;
    }
    const tags = tagsRaw.map((tag) => tag.trim());
    const badPattern = tags.map((tag) => tagPatternProblem(tag)).find((problem) => problem !== "");
    if (badPattern) {
      problems.push(`${where}: ${badPattern}`);
      return;
    }
    if (trigger === "tag" && tags.length === 0) {
      problems.push(`${where}: \`on: tag\` needs at least one pattern in \`tags\` \u2014 e.g. ["v*"].`);
      return;
    }
    if (trigger !== "tag" && tags.length > 0) {
      problems.push(`${where}: \`tags\` only applies to \`on: tag\`; this target is \`on: ${trigger}\`.`);
      return;
    }
    const before = problems.length;
    const commands = readCommands(entry.commands, where, problems);
    if (problems.length > before)
      return;
    seen.add(name);
    targets.push({ name, on: trigger, tags, commands });
  });
  return problems.length > 0 ? { targets: [], problems } : { targets, problems };
}
function tagPatternProblem(pattern) {
  const body = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
  if (body.includes("*")) {
    return `"${pattern}" uses a '*' somewhere other than the end, which this matcher cannot honour, ` + 'so it would match no tag. Write a literal tag, or a prefix followed by "*" \u2014 e.g. "v*".';
  }
  if (/[?[\]{}]/.test(body)) {
    return `"${pattern}" uses a glob character this matcher cannot honour, so it would match no tag. ` + 'Write a literal tag, or a prefix followed by "*".';
  }
  return "";
}

// src/domain/path-patterns.ts
var GLOB_CHARACTERS = /[*?[\]{}]/;
function pathPatternProblem(pattern) {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return "a path pattern must be a non-empty string";
  }
  if (pattern !== pattern.trim()) {
    return `"${pattern}" has surrounding whitespace`;
  }
  if (pattern.endsWith("/")) {
    return `"${pattern}" ends in a slash, so it would match nothing. ` + `Write "${pattern}**" for everything under it, or drop the slash to match that one path.`;
  }
  const body = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  if (body === "") {
    return `"${pattern}" names no directory. Write the directory before the "/**".`;
  }
  const glob = GLOB_CHARACTERS.exec(body);
  if (glob) {
    return `"${pattern}" uses the glob character '${glob[0]}', which this matcher cannot honour, ` + 'so it would match nothing. Write a literal path, or a directory followed by "/**".';
  }
  return "";
}

// src/domain/merge-gates.ts
var CONDITION_KEYS = [
  "files_added",
  "files_removed",
  "files_modified",
  "files_changed",
  "labels",
  "title_matches"
];
var GATE_KEYS = ["reason", "when"];
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readPatterns(raw, where, problems) {
  if (raw === undefined)
    return [];
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be an array of path patterns.`);
    return [];
  }
  if (raw.length === 0) {
    problems.push(`${where} is empty, so it constrains nothing; remove the key instead.`);
    return [];
  }
  const patterns = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      problems.push(`${where}: every pattern must be a string; found ${JSON.stringify(entry)}.`);
      continue;
    }
    const problem = pathPatternProblem(entry);
    if (problem) {
      problems.push(`${where}: ${problem}`);
      continue;
    }
    patterns.push(entry.trim());
  }
  return patterns;
}
function readLabels(raw, where, problems) {
  if (raw === undefined)
    return [];
  if (!Array.isArray(raw) || raw.some((label) => typeof label !== "string" || label.trim() === "")) {
    problems.push(`${where} must be an array of non-empty label names.`);
    return [];
  }
  if (raw.length === 0) {
    problems.push(`${where} is empty, so it constrains nothing; remove the key instead.`);
    return [];
  }
  return raw.map((label) => label.trim());
}
function readTitleMatches(raw, where, problems) {
  if (raw === undefined)
    return "";
  if (typeof raw !== "string" || raw.trim() === "") {
    problems.push(`${where} must be a non-empty regular expression.`);
    return "";
  }
  try {
    new RegExp(raw, "i");
  } catch (error) {
    problems.push(`${where} is not a valid regular expression: ${error.message}`);
    return "";
  }
  return raw;
}
function constrainsAnything(when) {
  return when.filesAdded.length > 0 || when.filesRemoved.length > 0 || when.filesModified.length > 0 || when.filesChanged.length > 0 || when.labels.length > 0 || when.titleMatches !== "";
}
function resolveMergeGates(raw) {
  if (raw === undefined || raw === null)
    return { gates: [], problems: [] };
  if (!Array.isArray(raw)) {
    return { gates: [], problems: ["`merge_gates` must be an array of gate objects."] };
  }
  const problems = [];
  const gates = [];
  raw.forEach((entry, index) => {
    const where = `\`merge_gates[${index}]\``;
    if (!isRecord2(entry)) {
      problems.push(`${where} must be an object with \`reason\` and \`when\`.`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!GATE_KEYS.includes(key)) {
        problems.push(`${where}: unknown key \`${key}\`; a gate has \`reason\` and \`when\`.`);
      }
    }
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (reason === "") {
      problems.push(`${where}: \`reason\` must say why a person should merge this, in their words.`);
    }
    if (!isRecord2(entry.when)) {
      problems.push(`${where}: \`when\` must be an object naming at least one condition ` + `(${CONDITION_KEYS.join(", ")}).`);
      return;
    }
    const declared = entry.when;
    for (const key of Object.keys(declared)) {
      if (!CONDITION_KEYS.includes(key)) {
        problems.push(`${where}: unknown condition \`${key}\`. A misspelled condition matches nothing, which ` + `looks exactly like a gate nobody needed -- so it is an error rather than a no-op. ` + `Known conditions: ${CONDITION_KEYS.join(", ")}.`);
      }
    }
    const when = {
      filesAdded: readPatterns(declared.files_added, `${where}.when.files_added`, problems),
      filesRemoved: readPatterns(declared.files_removed, `${where}.when.files_removed`, problems),
      filesModified: readPatterns(declared.files_modified, `${where}.when.files_modified`, problems),
      filesChanged: readPatterns(declared.files_changed, `${where}.when.files_changed`, problems),
      labels: readLabels(declared.labels, `${where}.when.labels`, problems),
      titleMatches: readTitleMatches(declared.title_matches, `${where}.when.title_matches`, problems)
    };
    if (!constrainsAnything(when)) {
      problems.push(`${where}: \`when\` names no usable condition, so this gate would stop every merge. ` + `Set \`merge_policy\` to "manual" if that is the intent.`);
      return;
    }
    gates.push({ reason, when });
  });
  return problems.length > 0 ? { gates: [], problems } : { gates, problems };
}

// src/domain/shipped-workflows.ts
var DEFAULT_CI_WORKFLOW = "atoma-check.yml";
var DEFAULT_CD_WORKFLOW = "atoma-deploy.yml";

// src/domain/deliverable-integrity.ts
var CONFIG_SCHEMA = {
  children: {
    merge_policy: null,
    base_branch: null,
    governed_paths: null,
    merge_gates: null,
    auto_triggers: null,
    checks: { children: { commands: null, secrets: null, runs_on: null } },
    deploy: { children: { targets: null, secrets: null, runs_on: null } },
    tools: { children: { secrets: null } },
    search: { children: { reranker_model: null } },
    environment: { children: { setup_commands: null } },
    workflows: { children: { ci: null, cd: null } },
    agents: { anyName: { children: { max_iterations: null } } },
    limits: { children: { agent_handoffs: null, environment_reloads: null } },
    labels: { children: { in_progress: null, sub_issue: null, launched: null }, anyName: null }
  }
};
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function unknownKeys(value, section, prefix) {
  if (!isRecord3(value))
    return [];
  const unknown = [];
  for (const [name, child] of Object.entries(value)) {
    const path = `${prefix}${name}`;
    const declared = section.children?.[name];
    if (declared !== undefined) {
      if (declared)
        unknown.push(...unknownKeys(child, declared, `${path}.`));
      continue;
    }
    if (section.anyName !== undefined) {
      if (section.anyName)
        unknown.push(...unknownKeys(child, section.anyName, `${path}.`));
      continue;
    }
    unknown.push(path);
  }
  return unknown;
}
function triggerAgent(agent) {
  return agent.startsWith("$") ? "" : agent;
}
function configProblems(facts) {
  const problems = [];
  const { config, agentNames, workflowFiles } = facts;
  if (!isRecord3(config)) {
    return ["`config.json` must be a JSON object."];
  }
  for (const key of unknownKeys(config, CONFIG_SCHEMA, "").sort()) {
    problems.push(`\`${key}\` in config.json is not a setting Atoma reads. Check the spelling.`);
  }
  const triggers = resolveAutoTriggers(config.auto_triggers);
  problems.push(...triggers.problems);
  problems.push(...resolveMergeGates(config.merge_gates).problems);
  const deploy = isRecord3(config.deploy) ? config.deploy : {};
  problems.push(...resolveDeployTargets(deploy.targets).problems);
  const checks = isRecord3(config.checks) ? config.checks : {};
  const tools = isRecord3(config.tools) ? config.tools : {};
  problems.push(...resolveDeclaredSecrets(tools.secrets, SECRET_DESTINATIONS.tools).problems);
  problems.push(...resolveDeclaredSecrets(checks.secrets, SECRET_DESTINATIONS.checks).problems);
  problems.push(...resolveDeclaredSecrets(deploy.secrets, SECRET_DESTINATIONS.deploy).problems);
  if (agentNames.length > 0) {
    const known = new Set(agentNames);
    const available = [...known].sort().join(", ");
    for (const trigger of triggers.triggers) {
      const agent = triggerAgent(trigger.agent);
      if (agent && !known.has(agent)) {
        problems.push(`\`auto_triggers\` routes \`${trigger.event}\` to '${agent}', which has no ` + `agent-definitions/${agent}.md. The event would dispatch a run that cannot start. ` + `Available: ${available}`);
      }
    }
    if (isRecord3(config.agents)) {
      for (const name of Object.keys(config.agents).sort()) {
        if (!known.has(name)) {
          problems.push(`\`agents.${name}\` configures an agent with no agent-definitions/${name}.md, ` + `so nothing reads it. Available: ${available}`);
        }
      }
    }
  } else {
    problems.push("No agent definitions were found. `.github/atoma/agent-definitions/*.md` is empty or missing.");
  }
  if (workflowFiles.length > 0) {
    const present = new Set(workflowFiles);
    const workflows = isRecord3(config.workflows) ? config.workflows : {};
    for (const [kind, fallback] of [
      ["ci", DEFAULT_CI_WORKFLOW],
      ["cd", DEFAULT_CD_WORKFLOW]
    ]) {
      const configured = typeof workflows[kind] === "string" ? workflows[kind].trim() : "";
      const effective = configured || fallback;
      if (!present.has(effective)) {
        problems.push(`\`workflows.${kind}\` resolves to '${effective}', which is not a file in .github/workflows/. ` + (configured ? "Check the name." : "The shipped default is missing from this repository."));
      }
    }
  }
  if (isRecord3(config.labels)) {
    for (const [key, value] of Object.entries(config.labels)) {
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`\`labels.${key}\` must be a non-empty label name.`);
      }
    }
  }
  return problems;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/validate_deliverable.ts
var ref = defineScript(import.meta.url);

class CannotCheck extends Error {
}
function validatorProblems(output) {
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("\u2717")).map((line) => line.replace(/^\u2717\s*/, ""));
}
function validateAgentDefinition(atoma, agentDef, toolsFile, label) {
  const proc = Bun.spawnSync({
    cmd: [atoma, "validate", "--agent-def", agentDef, "--tools-file", toolsFile],
    stdout: "pipe",
    stderr: "pipe"
  });
  const stdout = proc.stdout ? proc.stdout.toString("utf8") : "";
  const stderr = proc.stderr ? proc.stderr.toString("utf8") : "";
  if (proc.exitCode === null) {
    throw new CannotCheck(`could not run \`${atoma} validate\`: ${stderr.trim() || "no output"}`);
  }
  if (proc.exitCode === 0)
    return [];
  const found = validatorProblems(`${stdout}
${stderr}`);
  if (found.length > 0)
    return found.map((problem) => `${label}: ${problem}`);
  return [`${label}: \`atoma validate\` failed without saying why: ${stderr.trim() || stdout.trim() || "no output"}`];
}
function agentNames(agentDir) {
  if (!existsSync(agentDir))
    return [];
  return readdirSync(agentDir).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -".md".length)).sort();
}
function workflowFiles(workflowDir) {
  if (!existsSync(workflowDir))
    return [];
  return readdirSync(workflowDir).filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
}
function collect(root, atoma) {
  if (!existsSync(root))
    throw new CannotCheck(`--root ${root} does not exist`);
  const atomaDir = join(root, ".github", "atoma");
  const agentDir = join(atomaDir, "agent-definitions");
  const toolsFile = join(atomaDir, "tools", "tools.yaml");
  const configFile = join(atomaDir, "config.json");
  const names = agentNames(agentDir);
  const problems = [];
  if (!existsSync(configFile)) {
    problems.push(`${configFile} is missing. Every workflow reads it.`);
  } else {
    let config;
    try {
      config = JSON.parse(readFileSync(configFile, "utf8"));
    } catch (error) {
      problems.push(`${configFile} is not valid JSON: ${error.message}`);
    }
    if (config !== undefined) {
      problems.push(...configProblems({
        config,
        agentNames: names,
        workflowFiles: workflowFiles(join(root, ".github", "workflows"))
      }));
    }
  }
  if (names.length > 0) {
    if (!existsSync(toolsFile)) {
      problems.push(`${toolsFile} is missing, so every \`mcp_servers\` entry names a server that cannot resolve.`);
    } else {
      for (const name of names) {
        problems.push(...validateAgentDefinition(atoma, join(agentDir, `${name}.md`), toolsFile, `${name}.md`));
      }
    }
  }
  return problems;
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      root: { type: "string" },
      atoma: { type: "string" },
      report: { type: "string" }
    }
  });
  const root = values.root?.trim() || ".";
  const atoma = values.atoma?.trim() || "atoma";
  let problems;
  try {
    problems = collect(root, atoma);
  } catch (error) {
    if (!(error instanceof CannotCheck))
      throw error;
    console.error(`[atoma-validate-deliverable] cannot check: ${error.message}`);
    process.exit(2);
  }
  if (values.report)
    writeFileSync(values.report, problems.map((problem) => `${problem}
`).join(""));
  if (problems.length === 0) {
    console.log(`The deliverable in ${root} is internally consistent.`);
    return;
  }
  console.error(`${problems.length} problem(s) in ${root}:`);
  for (const problem of problems)
    console.error(`  - ${problem}`);
  process.exit(1);
}
if (import.meta.main)
  main();
export {
  ref,
  validatorProblems
};

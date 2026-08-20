#!/usr/bin/env bun
// @bun

// src/scripts/run_deploy.ts
import { parseArgs } from "util";

// src/domain/deploy-targets.ts
var TRIGGERS = ["merge", "tag", "manual"];
var NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
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
    if (!NAME_PATTERN.test(name)) {
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
function tagMatches(pattern, tag) {
  return pattern.endsWith("*") ? tag.startsWith(pattern.slice(0, -1)) : tag === pattern;
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
function targetsForMerge(targets) {
  return targets.filter((target) => target.on === "merge");
}
function targetsForTag(targets, ref) {
  const tag = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : ref;
  return targets.filter((target) => target.on === "tag" && target.tags.some((p) => tagMatches(p, tag)));
}
function targetByName(targets, name) {
  return targets.find((target) => target.name === name);
}

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
function getDeployTargets() {
  return resolveDeployTargets(loadConfig().deploy?.targets);
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/run_deploy.ts
var ref = defineScript(import.meta.url);
function selectTargets(targets, request) {
  if (request.target) {
    const named = targetByName(targets, request.target);
    if (!named)
      return null;
    return [named];
  }
  if (request.trigger === "merge")
    return targetsForMerge(targets);
  if (request.trigger === "manual")
    return [];
  if (request.ref.startsWith("refs/tags/"))
    return targetsForTag(targets, request.ref);
  if (request.ref.startsWith("refs/heads/"))
    return targetsForMerge(targets);
  return [];
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { ref: { type: "string" }, trigger: { type: "string" }, target: { type: "string" } }
  });
  const request = { ref: values.ref ?? "", trigger: values.trigger ?? "", target: (values.target ?? "").trim() };
  const { targets, problems } = getDeployTargets();
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::.github/atoma/config.json: ${problem}`);
    }
    process.exit(1);
  }
  const selected = selectTargets(targets, request);
  if (selected === null) {
    const known = targets.map((t) => t.name).join(", ") || "none are configured";
    console.error(`::error::No deploy target named '${request.target}'. Configured targets: ${known}.`);
    process.exit(1);
  }
  if (selected.length === 0) {
    console.log(`Nothing to deploy for ${request.ref || "this run"}; no target asked for it.`);
    return;
  }
  for (const target of selected) {
    console.log(`::group::Deploying ${target.name}`);
    for (const command of target.commands) {
      console.log(`$ ${command}`);
      const result = Bun.spawnSync({
        cmd: ["bash", "-c", command],
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, ATOMA_DEPLOY_TARGET: target.name }
      });
      if (result.exitCode !== 0) {
        console.log("::endgroup::");
        console.error(`::error::Deploy target '${target.name}' failed (exit ${result.exitCode}): ${command}`);
        process.exit(result.exitCode ?? 1);
      }
    }
    console.log("::endgroup::");
    console.log(`Deployed ${target.name}.`);
  }
}
if (import.meta.main)
  main();
export {
  selectTargets,
  ref
};

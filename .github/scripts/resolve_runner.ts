#!/usr/bin/env bun
// @bun

// src/scripts/resolve_runner.ts
import { appendFileSync } from "fs";
import { parseArgs } from "util";

// src/domain/runner-label.ts
var DEFAULT_RUNNER = "ubuntu-latest";
function resolveRunsOn(configured) {
  if (configured === undefined || configured === null)
    return { labels: [DEFAULT_RUNNER], problems: [] };
  if (typeof configured === "string") {
    const label = configured.trim();
    if (!label)
      return { labels: [DEFAULT_RUNNER], problems: ["runs_on is empty; using " + DEFAULT_RUNNER] };
    return { labels: [label], problems: [] };
  }
  if (Array.isArray(configured)) {
    const labels = configured.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
    const problems = [];
    if (labels.length !== configured.length) {
      problems.push("runs_on has entries that are not non-empty strings; those are ignored");
    }
    if (labels.length === 0) {
      return { labels: [DEFAULT_RUNNER], problems: [...problems, `runs_on names no usable label; using ${DEFAULT_RUNNER}`] };
    }
    return { labels, problems };
  }
  return { labels: [DEFAULT_RUNNER], problems: [`runs_on must be a string or a list of strings; using ${DEFAULT_RUNNER}`] };
}
function runsOnOutput(labels) {
  return JSON.stringify(labels);
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
function getRunsOn(field) {
  const config = loadConfig();
  return field === "checks" ? config.checks?.runs_on : config.deploy?.runs_on;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/resolve_runner.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { field: { type: "string" } } });
  const field = values.field ?? "";
  if (field !== "checks" && field !== "deploy") {
    console.error("usage: resolve_runner.ts --field checks|deploy");
    process.exit(2);
  }
  const { labels, problems } = resolveRunsOn(getRunsOn(field));
  for (const problem of problems)
    console.error(`::warning::${field}.${problem}`);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput)
    appendFileSync(githubOutput, `runs_on=${runsOnOutput(labels)}
`);
  console.error(`${field}.runs_on resolved to ${labels.join(", ")}`);
}
if (import.meta.main)
  main();
export {
  ref
};

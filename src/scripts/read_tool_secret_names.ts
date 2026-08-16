#!/usr/bin/env bun
/**
 * read_tool_secret_names.ts — publishes, as a step output, which repository
 * secrets this project's config.json lets a run hand to the agent.
 *
 * The output feeds a computed-key lookup in the "Run agent" step's `env:`
 * (`secrets[fromJSON(steps.tool-secrets.outputs.names)[i]]`), which is what lets
 * a project add a credential without editing generated workflow YAML. See
 * domain/tool-secrets.ts for why it is shaped that way and what was measured
 * before relying on it.
 *
 * Runs as a step rather than a job on purpose: step-level `env:` is evaluated
 * when the step runs, not when the job starts, so a step output can key a
 * secret. A prep job would have cost every agent run a second runner.
 *
 * Emits `names` as a JSON array, always — `[]` when nothing is configured, which
 * the workflow's `fromJSON(... || '[]')` also tolerates if this step is skipped.
 *
 * Fails the run on an unusable declaration. The alternative, delivering the
 * names that happen to be valid, turns a typo in config.json into a tool server
 * failing much later for reasons that point nowhere near the cause.
 *
 * Usage:
 *   read_tool_secret_names.ts
 */
import { appendFileSync } from "node:fs";
import { getToolSecrets } from "../lib/config.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

function main(): void {
  const { names, problems } = getToolSecrets();

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::.github/atoma/config.json: ${problem}`);
    }
    process.exit(1);
  }

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `names=${JSON.stringify(names)}\n`);
  }

  // Names only. The values are secrets; that these particular ones travel is
  // already public in config.json, and saying so makes a missing repository
  // secret diagnosable from the log.
  console.error(
    names.length > 0
      ? `Tool secrets declared: ${names.join(", ")}`
      : "No tool secrets declared; the agent gets only the credentials a run needs to work.",
  );
}

if (import.meta.main) main();

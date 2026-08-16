#!/usr/bin/env bun
/**
 * read_secret_names.ts — publishes, as a step output, which repository secrets
 * this project's config.json lets one destination reach.
 *
 * The output feeds a computed-key lookup in a later step's `env:`
 * (`secrets[fromJSON(steps.<id>.outputs.names)[i]]`), which is what lets a
 * project add a credential without editing generated workflow YAML. See
 * domain/declared-secrets.ts for why it is shaped that way and what was measured
 * before relying on it.
 *
 * Runs as a step rather than a job on purpose: step-level `env:` is evaluated
 * when the step runs, not when the job starts, so a step output can key a
 * secret. A prep job would have cost every run a second runner.
 *
 * Emits `names` as a JSON array, always — `[]` when nothing is configured, which
 * the workflow's `fromJSON(... || '[]')` also tolerates if this step is skipped.
 *
 * Fails the run on an unusable declaration. The alternative, delivering the
 * names that happen to be valid, turns a typo in config.json into a failure much
 * later, somewhere that points nowhere near the cause.
 *
 * Usage:
 *   read_secret_names.ts --destination tools|checks|deploy
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isSecretDestinationName } from "../domain/declared-secrets.ts";
import { getDeclaredSecrets } from "../lib/config.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface ReadSecretNamesArgs {
  /** Which of config.json's credential lists to publish. */
  destination: string;
}

export const ref = defineScript<ReadSecretNamesArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { destination: { type: "string" } } });
  const destination = values.destination ?? "";
  if (!isSecretDestinationName(destination)) {
    console.error(`::error::read_secret_names: unknown destination '${destination}'.`);
    process.exit(2);
  }

  const { names, problems } = getDeclaredSecrets(destination);

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
      ? `Secrets declared for ${destination}: ${names.join(", ")}`
      : `No secrets declared for ${destination}.`,
  );
}

if (import.meta.main) main();

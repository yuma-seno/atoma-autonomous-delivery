#!/usr/bin/env bun
/**
 * resolve_runner.ts — print the runner labels a later job should use.
 *
 * `runs-on` cannot read a file, so this runs in a small job first and the real job
 * takes its output. See `domain/runner-label.ts` for why that shape and not a
 * matrix.
 *
 * Usage: resolve_runner.ts --field checks|deploy
 *
 * Writes `runs_on` to $GITHUB_OUTPUT as a JSON array, always -- so the consumer is
 * always `fromJSON(...)` and one label and three are written the same way.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveRunsOn, runsOnOutput } from "../domain/runner-label.ts";
import { getRunsOn } from "../lib/config.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface ResolveRunnerArgs {
  field: string;
}

export const ref = defineScript<ResolveRunnerArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { field: { type: "string" } } });
  const field = values.field ?? "";
  if (field !== "checks" && field !== "deploy") {
    console.error("usage: resolve_runner.ts --field checks|deploy");
    process.exit(2);
  }

  const { labels, problems } = resolveRunsOn(getRunsOn(field));
  // Warnings, not failures. A bad `runs_on` still yields a runner that exists, so
  // the job runs and the project's commands are what report. `validate_deliverable`
  // shows the same problems at pull request time, where a person is reading.
  for (const problem of problems) console.error(`::warning::${field}.${problem}`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `runs_on=${runsOnOutput(labels)}\n`);
  console.error(`${field}.runs_on resolved to ${labels.join(", ")}`);
}

if (import.meta.main) main();

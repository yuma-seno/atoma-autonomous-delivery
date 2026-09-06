#!/usr/bin/env bun
/**
 * decide_guard_release.ts — computes, via the pure domain rule in
 * domain/serialization-guard.ts, whether the atoma/in-progress
 * SerializationGuard should be released after this run, and writes
 * `should_release=true|false` to $GITHUB_OUTPUT for the "Remove
 * atoma/in-progress label" step's `if:` to consume.
 *
 * This step must run with `if: always()` in the workflow (see
 * atoma-runner.wac.ts) so the decision is computed even when the agent run
 * itself failed or was skipped entirely -- shouldReleaseGuard()'s own rule
 * 1 handles that case (any non-'success' outcome releases the guard).
 * `--outcome` is expected to carry GitHub Actions' own `steps.atoma.outcome`
 * value directly ("success" | "failure" | "cancelled" | "skipped").
 *
 * IMPORTANT: unlike most scripts in this repo, this one deliberately does
 * NOT hard-fail (process.exit) on a missing/empty `--outcome`. This script
 * always runs under `always()`, and its entire purpose is to decide whether
 * a lock (the in-progress label) gets released -- exiting before writing
 * `should_release` to $GITHUB_OUTPUT would leave the downstream "Remove
 * label" step's condition evaluating against an empty/undefined output
 * (false), silently leaving the label stuck FOREVER with no error surfaced
 * anywhere. A missing/empty/unrecognized outcome is instead treated the
 * same as any other non-'success' outcome -- `succeeded` becomes false,
 * which shouldReleaseGuard()'s own rule 1 already resolves to "release" --
 * matching what the original inline bash expression
 * (`steps.atoma.outcome != 'success'`) would also have done for an empty
 * string. Fail toward releasing the guard, never toward holding it stuck.
 *
 * Usage:
 *   decide_guard_release.ts --outcome success
 *     [--limit-reached true] [--loop-limit-reached true]
 *     [--chain-continues true] [--directive AGENT_NAME]
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { shouldReleaseGuard } from "../domain/serialization-guard.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface DecideGuardReleaseArgs {
  outcome: string;
  "limit-reached"?: string;
  "loop-limit-reached"?: string;
  "chain-continues"?: string;
  directive?: string;
}

export const ref = defineScript<DecideGuardReleaseArgs>(import.meta.url);

function isTrue(v: string | undefined): boolean {
  return v === "true";
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      outcome: { type: "string" },
      "limit-reached": { type: "string" },
      "loop-limit-reached": { type: "string" },
      "chain-continues": { type: "string" },
      directive: { type: "string" },
    },
  });
  if (!values.outcome) {
    console.error("decide_guard_release: --outcome missing/empty -- treating as non-success (releases the guard)");
  }

  const release = shouldReleaseGuard({
    succeeded: values.outcome === "success",
    limitReached: isTrue(values["limit-reached"]),
    loopLimitReached: isTrue(values["loop-limit-reached"]),
    chainContinues: isTrue(values["chain-continues"]),
    directive: values.directive ?? "",
  });

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `should_release=${release}\n`);
  }
  console.error(`decide_guard_release: outcome=${values.outcome ?? "(missing)"} -> should_release=${release}`);
}

if (import.meta.main) main();

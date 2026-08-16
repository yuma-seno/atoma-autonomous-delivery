#!/usr/bin/env bun
/**
 * run_checks.ts — run config.json's `checks.commands`, in order, stopping at the
 * first failure.
 *
 * This is the body of `atoma-check.yml`. The verification itself is
 * configuration rather than workflow YAML because an agent can write the former
 * and not the latter: GITHUB_TOKEN is refused on `.github/workflows/**` by
 * identity, on every path and every branch. A project whose checks an agent is
 * expected to author has to express them somewhere an agent can reach.
 *
 * Declaring nothing is not an error. A repository that points `workflows.ci` at
 * a workflow of its own has no reason to fill this in, and failing its runs for
 * an empty list would make adopting Atoma harder than not adopting it. It says
 * so and exits clean.
 *
 * Mirrors GitHub Actions' own default `bash -e {0}` semantics: the first failing
 * command aborts with its exit code, so the job's conclusion is the command's.
 *
 * Usage:
 *   run_checks.ts
 */
import { getCheckCommands } from "../lib/config.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

function main(): void {
  const commands = getCheckCommands();
  if (commands.length === 0) {
    console.log(
      "No checks.commands configured, so there is nothing to verify. Add commands to .github/atoma/config.json, or point workflows.ci at a workflow of your own.",
    );
    return;
  }

  console.log(`Running ${commands.length} check command(s).`);
  for (const command of commands) {
    console.log(`::group::${command}`);
    const result = Bun.spawnSync({ cmd: ["bash", "-c", command], stdout: "inherit", stderr: "inherit" });
    console.log("::endgroup::");
    if (result.exitCode !== 0) {
      console.error(`::error::Check failed (exit ${result.exitCode}): ${command}`);
      process.exit(result.exitCode ?? 1);
    }
  }
  console.log("All checks passed.");
}

if (import.meta.main) main();

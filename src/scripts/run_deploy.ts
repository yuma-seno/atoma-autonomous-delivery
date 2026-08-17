#!/usr/bin/env bun
/**
 * run_deploy.ts — work out which of config.json's `deploy.targets` this run is
 * for, and run their commands.
 *
 * This is the body of `atoma-deploy.yml`. Selection happens here rather than in
 * the workflow's `on:` because `on:` takes no expression: a tag pattern that an
 * agent can edit cannot live there. The workflow listens for every tag and this
 * decides whether any target wanted it.
 *
 * How a run is selected, in order:
 *
 *   --target NAME    one named target, whatever its trigger. A name that matches
 *                    nothing fails, rather than falling back to something the
 *                    caller did not ask for.
 *   --trigger merge  every `on: merge` target. `dispatchCd` sends this after an
 *                    agent's merge, which uses GITHUB_TOKEN and so fires no
 *                    `push` for anything to catch.
 *   --trigger manual nothing. Someone dispatched by hand without naming a
 *                    target, and guessing which one they meant is worse than
 *                    telling them nothing happened.
 *   a pushed tag     every `on: tag` target whose pattern claims it.
 *   a pushed branch  every `on: merge` target. A person's merge does fire `push`,
 *                    and the workflow only listens on the default branch, so a
 *                    branch ref arriving here means a change landed there. Before
 *                    this, `on: merge` fired for an agent's merge and silently
 *                    not for a person's.
 *
 * Matching nothing is a clean exit, not a failure. A repository tags things for
 * reasons that have nothing to do with deploying, and a red run for each one
 * teaches people to ignore the red.
 *
 * Each target's commands run in order and the first failure ends the run with
 * its exit code. Later targets do not run: with one deployment already broken,
 * continuing puts more of the estate in an unknown state rather than less.
 *
 * Usage:
 *   run_deploy.ts --ref refs/tags/v1.0.0 [--trigger merge|manual] [--target production]
 */
import { parseArgs } from "node:util";
import { targetByName, targetsForMerge, targetsForTag, type DeployTarget } from "../domain/deploy-targets.ts";
import { getDeployTargets } from "../lib/config.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface RunDeployArgs {
  /** The ref this run is for; `refs/tags/<name>` selects tag targets. */
  ref: string;
  /** `merge` when dispatched after a pull request landed. */
  trigger?: string;
  /** A single target to run, by name. */
  target?: string;
}

export const ref = defineScript<RunDeployArgs>(import.meta.url);

/** The targets this run should deploy, or null when the request itself was bad. */
export function selectTargets(
  targets: readonly DeployTarget[],
  request: { ref: string; trigger: string; target: string },
): readonly DeployTarget[] | null {
  if (request.target) {
    const named = targetByName(targets, request.target);
    if (!named) return null;
    return [named];
  }
  if (request.trigger === "merge") return targetsForMerge(targets);
  if (request.trigger === "manual") return [];
  if (request.ref.startsWith("refs/tags/")) return targetsForTag(targets, request.ref);
  // Only a `push` reaches here with no trigger, and the workflow admits a branch
  // push only on the default branch, so this is a change landing there.
  if (request.ref.startsWith("refs/heads/")) return targetsForMerge(targets);
  return [];
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { ref: { type: "string" }, trigger: { type: "string" }, target: { type: "string" } },
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
        // Lets a command tell which deployment it is running under without the
        // target having to repeat its own name in every line.
        env: { ...process.env, ATOMA_DEPLOY_TARGET: target.name },
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

if (import.meta.main) main();

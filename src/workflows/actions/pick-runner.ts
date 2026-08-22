/**
 * pick-runner.ts — the small job that reads which machine a project's commands
 * should run on.
 *
 * `runs-on` takes no expression that can read a file, so the value has to already
 * be a job output by the time the real job starts. That is the whole reason this
 * job exists, and it is why it is a job rather than a step.
 *
 * It runs on `ubuntu-latest` unconditionally, and must: it is the job that finds out
 * what the configured runner is, so it cannot itself be on it. It does nothing but
 * read `config.json`, so the platform is irrelevant to what it produces.
 *
 * A function rather than two copies, for the reason `environment-setup.ts` gives:
 * two jobs need this and a second copy is a second thing to keep in step.
 *
 * ## Why the checkout, and why the machinery root
 *
 * `config.json` has to be read from somewhere. `atoma-check` reads the pull
 * request's OWN configuration on purpose -- that is what lets an agent change the
 * runner and prove the change in the same pull request, exactly as
 * `environment-setup.ts` argues for `setup_commands`. It grants nothing new: the job
 * already runs that branch's `checks.commands`.
 */
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { startJob, TypedOutputsStep } from "./base.ts";
import { SetupBunAction } from "./third-party.ts";
import { scriptCommandWithArgs } from "./script-call.ts";
import { ref as resolveRunnerRef } from "../../scripts/resolve_runner.ts";

/** The job's name. Referenced by the contract test that pins the required check's name. */
export const PICK_RUNNER_JOB = "pick-runner";

/**
 * A job that outputs `runs_on` as a JSON array, for a later job's
 * `runs-on: ${{ fromJSON(needs.<job>.outputs.runs_on) }}`.
 *
 * Always JSON, so one label and three are consumed identically -- see
 * `domain/runner-label.ts`.
 */
export function pickRunnerJob(field: "checks" | "deploy") {
  const resolveStep = new TypedOutputsStep(
    {
      name: "Read the configured runner",
      id: "runner",
      shell: "bash",
      run: `${scriptCommandWithArgs(resolveRunnerRef, { field })}\n`,
    },
    ["runs_on"] as const,
  );

  return startJob(
    PICK_RUNNER_JOB,
    {
      "runs-on": "ubuntu-latest",
      // Reading one small file. A minute is generous; the point of the limit is that
      // a hung checkout cannot hold the whole workflow.
      "timeout-minutes": 5,
      permissions: { contents: "read" },
      outputs: { runs_on: resolveStep.outputs.runs_on },
    },
    [
      new ActionsCheckoutV4({ name: "Checkout repository" }),
      new SetupBunAction({ name: "Setup Bun" }),
      resolveStep,
    ],
  );
}

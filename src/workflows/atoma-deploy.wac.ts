import { Workflow, type GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { startJob, TypedOutputsStep } from "./actions/base.ts";
import { scriptCommandWithArgs } from "./actions/script-call.ts";
import { renameSecretSlots, secretNamesStep, secretSlotEnv } from "./actions/secret-slots.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { ref as runDeployRef } from "../scripts/run_deploy.ts";

// Runs whatever config.json's `deploy.targets` says this project deploys.
//
// Same reason as atoma-check: GITHUB_TOKEN cannot write `.github/workflows/**`,
// so a deployment an agent is expected to author has to be configuration. This
// is the fixed shell; the targets, their triggers and their commands are all in
// config.json.
//
// Two triggers, for two things GitHub does differently.
//
// A pushed tag arrives as an event, and `on:` takes no expression -- a tag
// pattern that an agent can edit cannot live there. So this listens for every
// tag and `run_deploy.ts` decides whether any target wanted that one. A tag
// nobody asked for exits clean; a red run per unrelated tag would teach people
// to ignore the red.
//
// A merge does not arrive at all. An agent merges with GITHUB_TOKEN, which fires
// no `push` on the base branch, so `dispatchCd` starts this run explicitly with
// `trigger=merge`. It reads the targets before dispatching and does not start a
// run when no target deploys on merge, so that path costs nothing when unused.
//
// Schedules are absent on purpose: a cron expression can only be written in
// `on:`, so it cannot come from configuration, and a fixed daily cron that
// checks the time in a script burns 24 runs a day to do nothing.

const runStep = new TypedOutputsStep({
  name: "Deploy the targets this run is for",
  shell: "bash",
  env: {
    ...secretSlotEnv(),
    ATOMA_DEPLOY_REF: "${{ github.ref }}",
    ATOMA_DEPLOY_TRIGGER: "${{ inputs.trigger }}",
    ATOMA_DEPLOY_TARGET_INPUT: "${{ inputs.target }}",
  },
  run: `${renameSecretSlots()}
${scriptCommandWithArgs(runDeployRef, {
  ref: "${ATOMA_DEPLOY_REF}",
  trigger: "${ATOMA_DEPLOY_TRIGGER}",
  target: "${ATOMA_DEPLOY_TARGET_INPUT}",
})}
`,
});

export const atomaDeploy = new Workflow("atoma-deploy", {
  name: "Atoma Deploy",
  on: {
    workflow_dispatch: {
      inputs: {
        target: {
          description: "Deploy this one target by name. Leave empty to deploy what the trigger selects.",
          required: false,
          type: "string",
          default: "",
        },
        trigger: {
          description: "Set to 'merge' by dispatchCd after a pull request lands. Leave as 'manual' by hand.",
          required: false,
          type: "string",
          default: "manual",
        },
      },
    },
    // Every tag, filtered by `deploy.targets` at run time -- see above.
    push: { tags: ["*"] },
  } as unknown as GWT.Workflow["on"],
  permissions: {
    contents: "read",
    // So a deployment can exchange the run's identity for short-lived cloud
    // credentials instead of a long-lived key in a repository secret. Declared
    // here because a job's `permissions:` is one of the few things a command
    // genuinely cannot express -- unused, it grants nothing.
    "id-token": "write",
  },
}).addJobs(
  startJob(
    "deploy",
    {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 60,
      // Deployments queue rather than cancel. Cancelling one half way through
      // leaves the target in a state nobody chose, which is worse than waiting.
      concurrency: {
        group: "atoma-deploy-${{ github.ref }}",
        "cancel-in-progress": false,
      },
      permissions: { contents: "read", "id-token": "write" },
    },
    [
      new ActionsCheckoutV4({ name: "Checkout repository" }),
      new SetupBunAction({ name: "Setup Bun" }),
      secretNamesStep("deploy"),
      runStep,
    ],
  ).jobs(),
);

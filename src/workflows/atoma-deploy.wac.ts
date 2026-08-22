import { Workflow, type GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { DefinedJob, TypedOutputsStep } from "./actions/base.ts";
import { pickRunnerJob, PICK_RUNNER_JOB } from "./actions/pick-runner.ts";
import { scriptCommandWithArgs } from "./actions/script-call.ts";
import { renameSecretSlots, secretNamesStep, secretSlotEnv } from "./actions/secret-slots.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { environmentSetupStep } from "./actions/environment-setup.ts";
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
// A merge arrives two ways, and `on: merge` used to mean only one of them.
//
// An agent merges with GITHUB_TOKEN, which fires no `push`, so `dispatchCd`
// starts this run explicitly with `trigger=merge`. It reads the targets before
// dispatching and does not start a run when no target deploys on merge, so that
// path costs nothing when unused.
//
// A person's merge does fire `push`, and nothing was listening -- so a target
// declared `on: merge` deployed after an agent's merge and silently not after a
// person's. `push` on the default branch closes that.
//
// The branch list has to be literal, because `on:` takes no expression and there
// is no way to say "the default branch" there. `main` and `master` cover what
// repositories are actually called, and the job's `if:` then requires the ref to
// be the real default branch -- so a repository whose `main` is not the default
// starts no deployment, and one whose default is neither name uses `workflows.cd`.
//
// Schedules are absent on purpose: a cron expression can only be written in
// `on:`, so it cannot come from configuration, and a fixed daily cron that
// checks the time in a script burns 24 runs a day to do nothing.

const runStep = new TypedOutputsStep({
  name: "Deploy the targets this run is for",
  shell: "bash",
  env: {
    // The other half of `contents: write`. That permission is what lets a
    // deployment create a release or a tag, and this is what it uses to do it --
    // granting the one without the other is a permission nothing can reach.
    // Reserved against `deploy.secrets`, so a project cannot shadow it.
    GH_TOKEN: "${{ github.token }}",
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
    // Every tag, filtered by `deploy.targets` at run time -- see above. The
    // branches are the default-branch merge path, narrowed again by the job's
    // `if:`.
    // `**`, not `*`. This filter is meant to start the run for every tag and let
    // `run_deploy.ts` decide whether any target wanted that one -- but GitHub's
    // `*` does not cross `/`, so a validated `"tags": ["release/*"]` target never
    // started a run at all. `**` matches the separator too.
    push: { tags: ["**"], branches: ["main", "master"] },
  } as unknown as GWT.Workflow["on"],
  permissions: {
    // Write because cutting a release is a deployment, and the commonest thing a
    // deployment does on GitHub itself is create a release or a tag. Read would
    // mean every project that ships that way needs a personal access token in
    // `deploy.secrets` instead -- a long-lived credential, manually rotated,
    // usually scoped wider than this. The weaker-looking permission produces the
    // worse arrangement.
    //
    // This is the most privileged job in the system: it runs commands a project
    // wrote, with the credentials it declared, and can now write to the
    // repository. That is what makes `deploy.targets` a governed path worth
    // reading carefully, and why the declaration comes from the default branch
    // rather than from the branch under test.
    contents: "write",
    // So a deployment can exchange the run's identity for short-lived cloud
    // credentials instead of a long-lived key in a repository secret. Declared
    // here because a job's `permissions:` is one of the few things a command
    // genuinely cannot express -- unused, it grants nothing.
    "id-token": "write",
  },
}).addJobs(
  pickRunnerJob("deploy").then((pick) =>
    new DefinedJob(
    "deploy",
    {
      needs: [pick.name],
      // From `deploy.runs_on`, via the job above. One runner for the whole job:
      // the targets run in declared order and stop at the first failure, and that
      // ordering is the contract -- a runner per target would end it.
      "runs-on": `\${{ fromJSON(needs.${PICK_RUNNER_JOB}.outputs.runs_on) }}` as unknown as string,
      // `on:` could not say "the default branch", so this does. A dispatch and a
      // tag push pass through; a branch push has to be the branch the repository
      // actually defaults to, which is what stops a `main` that is not the
      // default from deploying.
      if: "github.event_name != 'push' || startsWith(github.ref, 'refs/tags/') || github.ref_name == github.event.repository.default_branch",
      "timeout-minutes": 60,
      // Deployments queue rather than cancel. Cancelling one half way through
      // leaves the target in a state nobody chose, which is worse than waiting.
      concurrency: {
        group: "atoma-deploy-${{ github.ref }}",
        "cancel-in-progress": false,
      },
      permissions: { contents: "write", "id-token": "write" },
    },
    [
      new ActionsCheckoutV4({ name: "Checkout repository" }),
      new SetupBunAction({ name: "Setup Bun" }),
      environmentSetupStep(),
      secretNamesStep("deploy"),
      runStep,
    ],
    ),
  ).jobs(),
);

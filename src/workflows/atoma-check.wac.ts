import { Workflow, type GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { startJob, TypedOutputsStep } from "./actions/base.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { renameSecretSlots, secretNamesStep, secretSlotEnv } from "./actions/secret-slots.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { ref as runChecksRef } from "../scripts/run_checks.ts";

// Runs whatever config.json's `checks.commands` says verifies this project.
//
// It exists so that a project's verification is something an agent can write.
// GITHUB_TOKEN is refused on `.github/workflows/**` by identity -- on every path
// and every branch, measured -- so an agent asked to set up CI for a new
// repository cannot author a workflow. It can author configuration, and this
// workflow is the fixed shell that runs it. Nothing here changes per project;
// everything that does lives in config.json.
//
// A repository that already has CI does not need this: point `workflows.ci` at
// that workflow instead and leave `checks.commands` unset, and the job says so
// and passes rather than failing over an empty list.
//
// `workflow_dispatch` is the only trigger, and that is deliberate rather than an
// omission. Agent branches are pushed and their pull requests opened with
// GITHUB_TOKEN, and GitHub starts no workflow run for its own token's events --
// so `push` and `pull_request` would never fire for exactly the pull requests
// this has to verify. `validate_pull_request.ts` dispatches it and mirrors the
// result onto the head commit where a ruleset can see it.

/** The name a required status check refers to. Pinned to the shipped ruleset by a contract test. */
export const CHECK_JOB_NAME = "atoma-check";

const runStep = new TypedOutputsStep({
  name: "Run the configured checks",
  shell: "bash",
  // The slots carry `checks.secrets` -- a private registry token, say. They are
  // this job's, not the agent's: nothing here runs an agent, and a credential
  // declared for checks never enters an agent's process.
  env: secretSlotEnv(),
  run: `${renameSecretSlots()}
${scriptCommand(runChecksRef)}
`,
});

export const atomaCheck = new Workflow("atoma-check", {
  name: "Atoma Check",
  on: { workflow_dispatch: {} } as unknown as GWT.Workflow["on"],
  // Reading the repository and running commands in it. Nothing here writes to
  // GitHub: the check run a ruleset reads is written by atoma-validate-pr, which
  // holds `checks: write` for that one purpose.
  permissions: { contents: "read" },
}).addJobs(
  startJob(
    CHECK_JOB_NAME,
    {
      "runs-on": "ubuntu-latest",
      // Long enough for a real test suite, short enough that a hung command does
      // not hold a runner all day.
      "timeout-minutes": 30,
      // One verification per ref at a time; a second push supersedes the first,
      // whose verdict is already stale.
      concurrency: {
        group: `atoma-check-\${{ github.ref }}`,
        "cancel-in-progress": true,
      },
      permissions: { contents: "read" },
    },
    [
      new ActionsCheckoutV4({ name: "Checkout repository" }),
      new SetupBunAction({ name: "Setup Bun" }),
      secretNamesStep("checks"),
      runStep,
    ],
  ).jobs(),
);

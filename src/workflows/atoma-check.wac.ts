import { Workflow, type GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { DefinedJob, TypedOutputsStep } from "./actions/base.ts";
import { pickRunnerJob, PICK_RUNNER_JOB } from "./actions/pick-runner.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { renameSecretSlots, secretNamesStep, secretSlotEnv } from "./actions/secret-slots.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { environmentSetupStep } from "./actions/environment-setup.ts";
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
// Two triggers, because the two kinds of pull request arrive differently.
//
// An agent's pull request is opened with GITHUB_TOKEN, and GitHub starts no
// workflow run for its own token's events -- so `pull_request` never fires for
// it. `validate_pull_request.ts` dispatches this workflow instead and mirrors the
// result onto the head commit where a ruleset can see it.
//
// A person's pull request does fire `pull_request`, and nothing was dispatching
// this workflow for one. Since this is what `workflows.ci` defaults to, that left
// a repository with no CI at all for its human contributors -- a required check
// that never ran, and a merge refused for a missing check until someone
// dispatched it by hand. So `pull_request` is listed too, and it is inert for the
// agent case by the same rule that made it necessary for the human one.

/** The name a required status check refers to. Pinned to the shipped ruleset by a contract test. */
export const CHECK_JOB_NAME = "atoma-check";

const runStep = new TypedOutputsStep({
  name: "Run the configured checks",
  shell: "bash",
  env: {
    // Checks routinely need one: `gh` for anything, a package manager reaching a
    // registry that authenticates with it, a submodule. Without it a project's
    // commands are the only ones in the system that cannot talk to GitHub, and
    // the failure reads as a broken command rather than a missing token.
    //
    // It grants no more than the job already holds. `contents: read` is what the
    // checkout used, so on a public repository this is what any visitor has, and
    // on a private one it is what the code being tested was fetched with. Not
    // shadowable either: `GH_TOKEN` is reserved against `checks.secrets`.
    GH_TOKEN: "${{ github.token }}",
    // The slots carry `checks.secrets` -- a private registry token, say. They are
    // this job's, not the agent's: nothing here runs an agent, and a credential
    // declared for checks never enters an agent's process.
    ...secretSlotEnv(),
  },
  run: `${renameSecretSlots()}
${scriptCommand(runChecksRef)}
`,
});

export const atomaCheck = new Workflow("atoma-check", {
  name: "Atoma Check",
  on: {
    workflow_dispatch: {},
    // The default set, written out: a person's pull request when it opens, when
    // it is pushed to, and when it comes back from closed. Marking a draft ready
    // changes no code, so the check already on that commit still stands.
    pull_request: { types: ["opened", "synchronize", "reopened"] },
  } as unknown as GWT.Workflow["on"],
  // Reading the repository and running commands in it. Nothing here writes to
  // GitHub: the check run a ruleset reads is written by atoma-validate-pr, which
  // holds `checks: write` for that one purpose.
  permissions: { contents: "read" },
}).addJobs(
  pickRunnerJob("checks").then((pick) =>
    new DefinedJob(
    CHECK_JOB_NAME,
    {
      needs: [pick.name],
      // From `checks.runs_on`, via the job above -- `runs-on` cannot read a file.
      // `fromJSON` always, so one label and a self-hosted runner's several are
      // consumed the same way. See `domain/runner-label.ts`.
      //
      // The job keeps its NAME. That is load-bearing: the ruleset requires the
      // context `atoma-check`, and a matrix here would rename it to
      // `atoma-check (ubuntu-latest)` -- so the required context would stop
      // existing and every pull request would wait on a check that never reports.
      "runs-on": `\${{ fromJSON(needs.${PICK_RUNNER_JOB}.outputs.runs_on) }}` as unknown as string,
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
      environmentSetupStep(),
      secretNamesStep("checks"),
      runStep,
    ],
    ),
  ).jobs(),
);

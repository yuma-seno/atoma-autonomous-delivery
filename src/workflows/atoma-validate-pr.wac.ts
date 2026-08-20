import { Workflow, type GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { startJob, TypedOutputsStep } from "./actions/base.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { DEFAULT_CI_WORKFLOW } from "../domain/shipped-workflows.ts";
import { scriptCommand, scriptCommandWithArgs } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { ATOMA_DEFAULT_VERSION, installAtomaCliStep } from "./actions/atoma-cli.ts";
import { ref as validatePullRequestRef } from "../scripts/validate_pull_request.ts";
import { ref as validateDeliverableRef } from "../scripts/validate_deliverable.ts";
import { buildArgv as configValueArgv, ref as getConfigValueRef } from "../scripts/get_config_value.ts";

// Runs CI against an agent's pull request and decides who works next.
//
// It is a workflow of its own rather than steps at the end of the engineer's
// run, because waiting is the point and the engineer's run is the wrong place to
// wait: it holds the `atoma/in-progress` label and the per-issue concurrency
// group, so several minutes of polling there stalls everything else queued
// behind that issue. This job holds neither.
//
// `workflow_dispatch` is the only trigger, and `create_pr` is what dispatches it.
// It cannot listen for the pull request instead: GitHub starts no workflow run
// for events GITHUB_TOKEN triggers, and an agent's pull request is created with
// GITHUB_TOKEN. Dispatch is the documented exception.
//
// See `scripts/validate_pull_request.ts` for why the check has to be written
// through the Checks API, and what must not be tidied away.
//
// It also checks the deliverable the pull request would merge, before asking CI to
// run at all. An agent editing its own tool surface is ordinary work, and until now
// it could merge a `.github/atoma/` that stops the next run from starting: atoma
// resolves every name in an agent's `mcp_servers` against tools.yaml and aborts
// before a single server starts, so the failure landed on whoever triggered the
// next run rather than on this pull request. See `scripts/validate_deliverable.ts`.

/**
 * Where the pull request's own tree is checked out, beside the default-branch one.
 *
 * This job runs on the default branch — `gh workflow run` with no `--ref` — so its
 * first checkout is the machinery: the scripts, and the atoma binary's version. The
 * content being judged is the pull request's, and it has to be fetched separately.
 *
 * That separation is the whole security story of this step. Everything under here is
 * DATA: a JSON file parsed, agent definitions and a tools file handed to a binary
 * downloaded from a release. Nothing in it is executed, nothing in it decides how
 * the validation behaves, and no script is loaded from it — which matters because
 * this job holds `checks: write` and could otherwise be made to write its own
 * passing check.
 *
 * The head branch is always in this repository: this workflow is dispatched for
 * pull requests agents open on `atoma/issue-N` branches. A fork's head would not
 * resolve here, and does not arrive here.
 */
const PR_HEAD_DIR = "pr-head";

/**
 * The file the two steps below pass between them, one problem per line.
 *
 * A file rather than a step output because it is a list, and a step output is one
 * line: `$GITHUB_OUTPUT` takes a multi-line value only through a delimiter block,
 * and the engineer needs every problem at once rather than one per round trip.
 *
 * Outside the workspace, so neither checkout can have placed it and nothing commits
 * it.
 */
const DELIVERABLE_REPORT = "${RUNNER_TEMP}/atoma-deliverable-problems.txt";

/**
 * Check the deliverable, and let a red verdict through to the next step.
 *
 * The distinction the exit code carries is the point. 1 means the deliverable is
 * inconsistent, which is a verdict about the pull request and belongs on the check
 * run `validate_pull_request.ts` writes — failing the job here would leave the
 * required context pending forever and dispatch nobody, so an ordinary mistake
 * would need a human every time. Anything above 1 means the check did not happen,
 * and that must not be able to look like a clean one.
 */
const deliverableStep = new TypedOutputsStep({
  name: "Validate the deliverable this pull request would merge",
  shell: "bash",
  run: `STATUS=0
${scriptCommandWithArgs(validateDeliverableRef, { root: PR_HEAD_DIR, report: DELIVERABLE_REPORT })} || STATUS=\$?
if [ "\$STATUS" -gt 1 ]; then
  echo "::error::the deliverable could not be validated; see the log above"
  exit 1
fi
`,
});

const configStep = new TypedOutputsStep(
  {
    name: "Read the CI workflow name from config",
    id: "cfg",
    shell: "bash",
    // The same fallback as the tool side, by importing it rather than by matching it:
    // a repository that never set `workflows.ci` validates against the workflow that
    // certainly exists, and there is one name to change if that ever moves.
    run: `WORKFLOW=$(${scriptCommand(getConfigValueRef, configValueArgv("workflows.ci", DEFAULT_CI_WORKFLOW))})
echo "workflow=\${WORKFLOW}" >> "$GITHUB_OUTPUT"
`,
  },
  ["workflow"] as const,
);

const validateStep = new TypedOutputsStep(
  {
    name: "Run CI and write its result where the ruleset looks",
    id: "validate",
    shell: "bash",
    env: { GH_TOKEN: "${{ github.token }}" },
    run: `${scriptCommandWithArgs(validatePullRequestRef, {
      repo: "${{ github.repository }}",
      number: "${{ inputs.number }}",
      branch: "${{ inputs.branch }}",
      workflow: configStep.outputs.workflow,
      reviewer: "${{ inputs.reviewer }}",
      engineer: "${{ inputs.engineer }}",
      "deliverable-report": DELIVERABLE_REPORT,
    })}\n`,
  },
  ["next_agent", "conclusion", "summary"] as const,
);

export const atomaValidatePr = new Workflow("atoma-validate-pr", {
  name: "Atoma Validate PR",
  // Cast for the same upstream reason atoma-runner.wac.ts casts: the generated
  // `WorkflowDispatchInput.default` type is a json-schema-to-typescript quirk.
  // Structurally this is valid `workflow_dispatch` YAML.
  on: {
    workflow_dispatch: {
      inputs: {
        number: { description: "Pull request number", required: true, type: "string" },
        branch: { description: "Head branch of the pull request", required: true, type: "string" },
        reviewer: {
          description: "Agent to dispatch when CI passes",
          required: false,
          type: "string",
          default: "reviewer",
        },
        engineer: {
          description: "Agent to dispatch when CI fails",
          required: false,
          type: "string",
          default: "engineer",
        },
      },
    },
  } as unknown as GWT.Workflow["on"],
  permissions: {
    ...ATOMA_WORKFLOW_PERMISSIONS,
    // Writing the mirrored check run. Without this the pull request can never
    // satisfy a required status check -- see validate_pull_request.ts.
    checks: "write",
  },
}).addJobs(
  startJob(
    "validate",
    {
      "runs-on": "ubuntu-latest",
      // Long enough for a slow CI run, short enough that a hung one does not
      // occupy a runner all day. The script's own deadline is shorter still, so
      // it reports "no conclusion" and writes a failing check rather than being
      // killed here with nothing recorded.
      "timeout-minutes": 45,
      // One validation per pull request at a time. A second push while the first
      // is still polling would otherwise race to write the same check.
      concurrency: {
        group: "atoma-validate-${{ inputs.number }}",
        "cancel-in-progress": true,
      },
      permissions: { ...ATOMA_WORKFLOW_PERMISSIONS, checks: "write" },
    },
    [
      new ActionsCheckoutV4({ name: "Checkout repository" }),
      new ActionsCheckoutV4({
        name: "Checkout the pull request's own tree, as data",
        with: { ref: "${{ inputs.branch }}", path: PR_HEAD_DIR },
      }),
      new SetupBunAction({ name: "Setup Bun" }),
      // The version the runner would install by default. A dispatch that overrides
      // `atoma_version` for a RUN is not reflected here, so the validation reads the
      // deliverable as the default-version binary does — which is what a repository
      // that never overrides it gets, and what an adopter's next run will use.
      installAtomaCliStep(ATOMA_DEFAULT_VERSION),
      deliverableStep,
      configStep,
      validateStep,
      new TypedOutputsStep({
        name: "Dispatch the agent the result calls for",
        // Empty when CI never reported. There is no defect to hand anyone, so
        // the failing check stands and a human picks it up.
        if: `${validateStep.rawOutputs.next_agent} != ''`,
        shell: "bash",
        env: {
          GH_TOKEN: "${{ github.token }}",
          AGENT: validateStep.outputs.next_agent,
          NUMBER: "${{ inputs.number }}",
          SUMMARY: validateStep.outputs.summary,
        },
        run: `gh workflow run atoma-runner.yml \\
  --repo "\${{ github.repository }}" \\
  -f agent="$AGENT" \\
  -f number="$NUMBER" \\
  -f type=pr
echo "Dispatched $AGENT for #$NUMBER: $SUMMARY"
`,
      }),
    ],
  ).jobs(),
);

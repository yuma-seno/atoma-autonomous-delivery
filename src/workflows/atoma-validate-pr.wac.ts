import { Workflow, type GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { startJob, TypedOutputsStep } from "./actions/base.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { DEFAULT_CI_WORKFLOW } from "../lib/dispatch-targets.ts";
import { scriptCommand, scriptCommandWithArgs } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { ref as validatePullRequestRef } from "../scripts/validate_pull_request.ts";
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
      new SetupBunAction({ name: "Setup Bun" }),
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

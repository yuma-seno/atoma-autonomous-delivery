import { Workflow, NormalJob } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { TypedJobOutputs, TypedOutputsStep } from "./actions/base.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { atomaRunnerWorkflow } from "./atoma-runner.wac.ts";
import type { MatchTriggerEnv } from "../scripts/match_trigger.ts";
// Path-validation-only import: see the identical note in atoma-auto-trigger.wac.ts.
import type * as ExtractNotifyTag from "../scripts/extract_notify_tag.ts";

// Separate workflow for pull_request_review events.
// Cannot be combined with pull_request_target in atoma-auto-trigger.wac.ts.
const checkoutStep = new ActionsCheckoutV4({});

// Required by the "Match event to agent" step below, which runs
// match_trigger.ts via `bun run` -- not preinstalled on GitHub-hosted runners.
const setupBunStep = new SetupBunAction();

const contextStep = new TypedOutputsStep(
  {
    name: "Determine PR number",
    id: "context",
    shell: "bash",
    run: `echo "number=\${{ github.event.pull_request.number }}" >> "$GITHUB_OUTPUT"
echo "type=pr" >> "$GITHUB_OUTPUT"
`,
  },
  ["number", "type"] as const,
);

const notifyStep = new TypedOutputsStep(
  {
    name: "Resolve notify login from PR body tag",
    id: "notify",
    shell: "bash",
    env: { PR_BODY: "${{ github.event.pull_request.body }}" },
    run: `${scriptCommand("../scripts/extract_notify_tag.ts")}\n`,
  },
  ["notify"] as const,
);

const matchStep = new TypedOutputsStep(
  {
    name: "Match event to agent from config.json",
    id: "match",
    shell: "bash",
    env: {
      EVENT_TYPE: "${{ github.event_name }}.${{ github.event.action }}",
      REVIEW_STATE: "${{ github.event.review.state }}",
    } satisfies MatchTriggerEnv,
    run: `AGENT=$(${scriptCommand("../scripts/match_trigger.ts")} 2>/dev/null || true)
if [ -n "\${AGENT}" ]; then
  echo "Matched agent: \${AGENT}"
  echo "agent=\${AGENT}" >> "$GITHUB_OUTPUT"
  echo "number=${contextStep.outputs.number}" >> "$GITHUB_OUTPUT"
  echo "type=${contextStep.outputs.type}" >> "$GITHUB_OUTPUT"
fi
`,
  },
  ["agent", "number", "type"] as const,
);

const routeJob = new NormalJob("route", {
  "runs-on": "ubuntu-latest",
  outputs: {
    agent: matchStep.outputs.agent,
    number: matchStep.outputs.number,
    type: matchStep.outputs.type,
    notify: notifyStep.outputs.notify,
  },
}).addSteps([checkoutStep, setupBunStep, contextStep, notifyStep, matchStep]);

const routeOutputs = new TypedJobOutputs(routeJob, ["agent", "number", "type", "notify"] as const);

// NOTE: preserved verbatim from the original hand-written YAML -- unlike the
// other routing workflows, this job intentionally has no `secrets: inherit`.
const runJob = atomaRunnerWorkflow.call("run", {
  needs: [routeJob],
  if: `${routeOutputs.rawOutputs.agent} != ''`,
  with: {
    agent: routeOutputs.outputs.agent,
    number: routeOutputs.outputs.number,
    type: routeOutputs.outputs.type,
    notify: routeOutputs.outputs.notify,
  },
});

export const atomaPrReview = new Workflow("atoma-pr-review", {
  name: "Atoma PR Review",
  on: {
    pull_request_review: { types: ["submitted"] },
  },
  permissions: {
    actions: "write",
    issues: "write",
    "pull-requests": "write",
    contents: "write",
  },
}).addJobs([routeJob, runJob]);

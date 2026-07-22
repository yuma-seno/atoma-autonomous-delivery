import { Workflow, NormalJob } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { TypedJobOutputs, TypedOutputsStep } from "./actions/base.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { atomaRunnerWorkflow } from "./atoma-runner.wac.ts";
import type { MatchTriggerEnv } from "../scripts/match_trigger.ts";
// Path-validation-only import: extract_notify_tag.ts exports no Args/Env
// type (its only input is the PR_BODY env var), so this exists solely to
// make a renamed/deleted script fail `bun run typecheck` at the
// `scriptCommand()` call site below.
import type * as ExtractNotifyTag from "../scripts/extract_notify_tag.ts";

// Generic workflow triggered by GitHub events.
// Uses pull_request_target (NOT pull_request) because GITHUB_TOKEN-created PRs
// trigger the event but GitHub suppresses workflow runs for pull_request events.
// pull_request_target runs in the base repo context with full write permissions.
//
// pull_request_review is handled in a separate workflow (atoma-pr-review.wac.ts)
// because pull_request_target and pull_request_review cannot be combined.
const checkoutStep = new ActionsCheckoutV4({});

// Required by the "Match event to agent" step below, which runs
// match_trigger.ts via `bun run` -- not preinstalled on GitHub-hosted runners.
const setupBunStep = new SetupBunAction();

const contextStep = new TypedOutputsStep(
  {
    name: "Determine PR number from event context",
    id: "context",
    shell: "bash",
    run: `if [ -n "\${{ github.event.pull_request.number }}" ]; then
  echo "number=\${{ github.event.pull_request.number }}" >> "$GITHUB_OUTPUT"
  echo "type=pr" >> "$GITHUB_OUTPUT"
else
  echo "number=\${{ github.event.issue.number }}" >> "$GITHUB_OUTPUT"
  echo "type=issue" >> "$GITHUB_OUTPUT"
fi
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
      IS_DRAFT: "${{ github.event.pull_request.draft }}",
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

const runJob = atomaRunnerWorkflow.call("run", {
  needs: [routeJob],
  if: `${routeOutputs.rawOutputs.agent} != ''`,
  with: {
    agent: routeOutputs.outputs.agent,
    number: routeOutputs.outputs.number,
    type: routeOutputs.outputs.type,
    notify: routeOutputs.outputs.notify,
  },
  secrets: "inherit",
});

export const atomaAutoTrigger = new Workflow("atoma-auto-trigger", {
  name: "Atoma Auto Trigger",
  on: {
    pull_request_target: { types: ["opened", "synchronize", "ready_for_review"] },
  },
  permissions: {
    actions: "write",
    issues: "write",
    "pull-requests": "write",
    contents: "write",
  },
}).addJobs([routeJob, runJob]);

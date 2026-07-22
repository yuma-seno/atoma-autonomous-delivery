import { Workflow, NormalJob, ReusableWorkflowCallJob } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { TypedOutputsStep } from "./actions/base.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import type { MatchTriggerEnv } from "../scripts/match_trigger.ts";

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
    run: "bun run .github/atoma/tools/scripts/extract_notify_tag.ts\n",
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
    run: `AGENT=$(bun run .github/atoma/tools/scripts/match_trigger.ts 2>/dev/null || true)
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

// NOTE: preserved verbatim from the original hand-written YAML -- unlike the
// other routing workflows, this job intentionally has no `secrets: inherit`.
const runJob = new ReusableWorkflowCallJob("run", {
  if: `needs.${routeJob.name}.outputs.agent != ''`,
  uses: "./.github/workflows/atoma-runner.yml",
  with: {
    agent: `\${{ needs.${routeJob.name}.outputs.agent }}`,
    number: `\${{ needs.${routeJob.name}.outputs.number }}`,
    type: `\${{ needs.${routeJob.name}.outputs.type }}`,
    notify: `\${{ needs.${routeJob.name}.outputs.notify }}`,
  },
}).needs([routeJob]);

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

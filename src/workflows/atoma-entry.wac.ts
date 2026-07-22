import { Workflow, NormalJob, ReusableWorkflowCallJob, Step } from "@github-actions-workflow-ts/lib";
import { TypedOutputsStep } from "./actions/base.ts";
import { SetupBunAction } from "./actions/third-party.ts";

// Required by the "Resolve agent and context" step below, which runs
// resolve_entry_agent.ts via `bun run` -- not preinstalled on GitHub-hosted
// runners.
const setupBunStep = new SetupBunAction();

const resolveStep = new TypedOutputsStep(
  {
    name: "Resolve agent and context",
    id: "resolve",
    shell: "bash",
    env: {
      NUMBER: "${{ github.event.issue.number }}",
      SENDER: "${{ github.event.sender.login }}",
    },
    run: "# sync-dist push verification (harmless no-op)\nbun run .github/atoma/tools/scripts/resolve_entry_agent.ts\n",
  },
  ["agent", "number", "type", "notify"] as const,
);

const addReactionStep = new Step({
  name: "Add reaction to issue",
  if: `${resolveStep.rawOutputs.agent} != ''`,
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: "${{ github.event.issue.number }}",
  },
  run: `gh api --method POST "repos/\${GITHUB_REPOSITORY}/issues/\${NUMBER}/reactions" -f content="eyes" 2>/dev/null || true
`,
});

const routeJob = new NormalJob("route", {
  "runs-on": "ubuntu-latest",
  outputs: {
    agent: resolveStep.outputs.agent,
    number: resolveStep.outputs.number,
    type: resolveStep.outputs.type,
    notify: resolveStep.outputs.notify,
  },
}).addSteps([setupBunStep, resolveStep, addReactionStep]);

const runJob = new ReusableWorkflowCallJob("run", {
  if: `needs.${routeJob.name}.outputs.agent != ''`,
  uses: "./.github/workflows/atoma-runner.yml",
  with: {
    agent: `\${{ needs.${routeJob.name}.outputs.agent }}`,
    number: `\${{ needs.${routeJob.name}.outputs.number }}`,
    type: `\${{ needs.${routeJob.name}.outputs.type }}`,
    notify: `\${{ needs.${routeJob.name}.outputs.notify }}`,
  },
  secrets: "inherit",
}).needs([routeJob]);

export const atomaEntry = new Workflow("atoma-entry", {
  name: "Atoma Entry",
  on: {
    issues: { types: ["opened"] },
  },
  permissions: {
    actions: "write",
    issues: "write",
    "pull-requests": "write",
    contents: "write",
  },
}).addJobs([routeJob, runJob]);

import { Workflow, NormalJob, Step } from "@github-actions-workflow-ts/lib";
import { TypedJobOutputs, TypedOutputsStep } from "./actions/base.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { atomaRunnerWorkflow } from "./atoma-runner.wac.ts";
// Path-validation-only import: resolve_entry_agent.ts exports no Args/Env
// type (it reads NUMBER/SENDER from env and writes $GITHUB_OUTPUT directly),
// so this exists solely to make a renamed/deleted script fail
// `bun run typecheck` at the `scriptCommand()` call site below.
import type * as ResolveEntryAgent from "../scripts/resolve_entry_agent.ts";

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
    run: `${scriptCommand("../scripts/resolve_entry_agent.ts")}\n`,
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

import { Workflow, Step } from "@github-actions-workflow-ts/lib";
import type { IssuesOpenedEvent } from "@octokit/webhooks-types";
import { DefinedJob, TypedOutputsStep } from "./actions/base.ts";
import { githubEvent } from "./actions/github-context.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { atomaRunnerWorkflow } from "./atoma-runner.wac.ts";
import { ref as resolveEntryAgentRef } from "../scripts/resolve_entry_agent.ts";

// Fires when a new issue is opened. Resolves which agent (if any) should
// handle it from the issue body's first line, then hands off to the shared
// atoma-runner reusable workflow.
//
// Job graph:
//   route --> run (atoma-runner.yml, reusable)

const resolveStep = new TypedOutputsStep(
  {
    name: "Resolve agent and context",
    id: "resolve",
    shell: "bash",
    env: {
      NUMBER: githubEvent<IssuesOpenedEvent>((e) => e.issue.number),
      SENDER: githubEvent<IssuesOpenedEvent>((e) => e.sender.login),
    },
    run: `${scriptCommand(resolveEntryAgentRef)}\n`,
  },
  ["agent", "number", "type", "notify"] as const,
);

const routeJob = new DefinedJob(
  "route",
  {
    "runs-on": "ubuntu-latest",
    outputs: {
      agent: resolveStep.outputs.agent,
      number: resolveStep.outputs.number,
      type: resolveStep.outputs.type,
      notify: resolveStep.outputs.notify,
    },
  },
  [
    // Required by the "Resolve agent and context" step below, which runs
    // resolve_entry_agent.ts via `bun run` -- not preinstalled on
    // GitHub-hosted runners.
    new SetupBunAction(),
    resolveStep,
    new Step({
      name: "Add reaction to issue",
      if: `${resolveStep.rawOutputs.agent} != ''`,
      shell: "bash",
      env: {
        GH_TOKEN: "${{ github.token }}",
        NUMBER: githubEvent<IssuesOpenedEvent>((e) => e.issue.number),
      },
      run: `gh api --method POST "repos/\${GITHUB_REPOSITORY}/issues/\${NUMBER}/reactions" -f content="eyes" 2>/dev/null || true
`,
    }),
  ],
);

export const atomaEntry = new Workflow("atoma-entry", {
  name: "Atoma Entry",
  on: {
    issues: { types: ["opened"] },
  },
  permissions: ATOMA_WORKFLOW_PERMISSIONS,
}).addJobs([
  routeJob,
  atomaRunnerWorkflow.call("run", {
    needs: [routeJob],
    if: `${routeJob.rawOutputs.agent} != ''`,
    with: {
      agent: routeJob.outputs.agent,
      number: routeJob.outputs.number,
      type: routeJob.outputs.type,
      notify: routeJob.outputs.notify,
    },
    secrets: "inherit",
  }),
]);

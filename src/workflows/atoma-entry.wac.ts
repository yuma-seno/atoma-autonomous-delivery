import { Workflow, Step } from "@github-actions-workflow-ts/lib";
import type { IssuesOpenedEvent } from "@octokit/webhooks-types";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { startJob, TypedOutputsStep } from "./actions/base.ts";
import { githubEvent, githubEventRaw, isRepositoryMember } from "./actions/github-context.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { dispatchToAtomaRunner } from "./atoma-runner.wac.ts";
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

export const atomaEntry = new Workflow("atoma-entry", {
  name: "Atoma Entry",
  on: {
    issues: { types: ["opened"] },
  },
  permissions: ATOMA_WORKFLOW_PERMISSIONS,
}).addJobs(
  startJob(
    "route",
    {
      "runs-on": "ubuntu-latest",
      // Only a repository member's issue starts an agent. An outside contributor
      // may open issues freely; none of them spend model budget or hand an agent
      // instructions from someone without write access.
      if: isRepositoryMember(githubEventRaw<IssuesOpenedEvent>((e) => e.issue.author_association)),
      outputs: {
        agent: resolveStep.outputs.agent,
        number: resolveStep.outputs.number,
        type: resolveStep.outputs.type,
        notify: resolveStep.outputs.notify,
      },
    },
    [
      new ActionsCheckoutV4({}),
      // Required by the "Resolve agent and context" step below, which runs
      // resolve_entry_agent.ts via `bun run` -- not preinstalled on
      // GitHub-hosted runners.
      new SetupBunAction({ name: "Setup Bun" }),
      resolveStep,
    ],
  )
    .then((routeJob) => dispatchToAtomaRunner(routeJob, "inherit"))
    .jobs(),
);

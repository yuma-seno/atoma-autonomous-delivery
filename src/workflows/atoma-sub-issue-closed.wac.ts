import { Workflow } from "@github-actions-workflow-ts/lib";
import type { IssuesClosedEvent } from "@octokit/webhooks-types";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { DefinedJob, startJob, TypedOutputsStep } from "./actions/base.ts";
import { githubEvent } from "./actions/github-context.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { scriptCommand, scriptCommandWithArgs } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { ref as dispatchIfSiblingsDoneRef } from "../scripts/dispatch_if_siblings_done.ts";
import { ref as checkSubIssueClosureRef } from "../scripts/check_sub_issue_closure.ts";

// FALLBACK for manually closed sub-issues.
// Primary aggregation happens in atoma-pr-merged.wac.ts (pull_request_target).
// This handles the case where a human closes a sub-issue manually.
//
// Job graph:
//   check --> aggregate

const checkStep = new TypedOutputsStep(
  {
    name: "Check sub-issue closure (parent tag + already-handled-via-PR?)",
    id: "check",
    shell: "bash",
    env: {
      CLOSED_NUM: githubEvent<IssuesClosedEvent>((e) => e.issue.number),
      GH_TOKEN: "${{ github.token }}",
      OWNER: "${{ github.repository_owner }}",
      REPO: githubEvent<IssuesClosedEvent>((e) => e.repository.name),
    },
    run: `${scriptCommand(checkSubIssueClosureRef)}\n`,
  },
  ["is_sub_issue", "parent_number", "closed_via_pr"] as const,
);

export const atomaSubIssueClosed = new Workflow("atoma-sub-issue-closed", {
  name: "Atoma Sub-Issue Closed",
  on: {
    issues: { types: ["closed"] },
  },
  permissions: ATOMA_WORKFLOW_PERMISSIONS,
}).addJobs(
  startJob(
    "check",
    {
      "runs-on": "ubuntu-latest",
      outputs: {
        is_sub_issue: checkStep.outputs.is_sub_issue,
        parent_number: checkStep.outputs.parent_number,
        closed_via_pr: checkStep.outputs.closed_via_pr,
      },
    },
    [new SetupBunAction(), checkStep],
  )
    .then(
      (checkJob) =>
        new DefinedJob(
          "aggregate",
          {
            "runs-on": "ubuntu-latest",
            if: `${checkJob.rawOutputs.is_sub_issue} == 'true' && ${checkJob.rawOutputs.closed_via_pr} != 'true'`,
          },
          [
            new ActionsCheckoutV4({}),
            new SetupBunAction(),
            new TypedOutputsStep({
              name: "Check siblings and re-trigger orchestrator",
              shell: "bash",
              env: {
                GH_TOKEN: "${{ github.token }}",
                OWNER: "${{ github.repository_owner }}",
                REPO: githubEvent<IssuesClosedEvent>((e) => e.repository.name),
                PARENT: checkJob.outputs.parent_number,
              },
              run: `${scriptCommandWithArgs(dispatchIfSiblingsDoneRef, { repo: "\${OWNER}/\${REPO}", parent: "\${PARENT}" })}
`,
            }),
          ],
          [checkJob],
        ),
    )
    .jobs(),
);

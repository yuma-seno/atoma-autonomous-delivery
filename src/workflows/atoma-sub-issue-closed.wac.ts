import { Workflow, NormalJob } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { TypedOutputsStep } from "./actions/base.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { toArgv } from "../scripts/lib/cli.ts";
import type { DispatchIfSiblingsDoneArgs } from "../scripts/dispatch_if_siblings_done.ts";
// Path-validation-only import: check_sub_issue_closure.ts exports no
// Args/Env type (it reads CLOSED_NUM/OWNER/REPO from env and writes
// $GITHUB_OUTPUT directly), so this exists solely to make a renamed/deleted
// script fail `bun run typecheck` at the `scriptCommand()` call site below.
import type * as CheckSubIssueClosure from "../scripts/check_sub_issue_closure.ts";

// FALLBACK for manually closed sub-issues.
// Primary aggregation happens in atoma-pr-merged.wac.ts (pull_request_target).
// This handles the case where a human closes a sub-issue manually.

const checkStep = new TypedOutputsStep(
  {
    name: "Check sub-issue closure (parent tag + already-handled-via-PR?)",
    id: "check",
    shell: "bash",
    env: {
      CLOSED_NUM: "${{ github.event.issue.number }}",
      GH_TOKEN: "${{ github.token }}",
      OWNER: "${{ github.repository_owner }}",
      REPO: "${{ github.event.repository.name }}",
    },
    run: `${scriptCommand("../scripts/check_sub_issue_closure.ts")}\n`,
  },
  ["is_sub_issue", "parent_number", "closed_via_pr"] as const,
);

const checkJob = new NormalJob("check", {
  "runs-on": "ubuntu-latest",
  outputs: {
    is_sub_issue: checkStep.outputs.is_sub_issue,
    parent_number: checkStep.outputs.parent_number,
    closed_via_pr: checkStep.outputs.closed_via_pr,
  },
}).addSteps([new SetupBunAction(), checkStep]);

const aggregateStep = new TypedOutputsStep({
  name: "Check siblings and re-trigger orchestrator",
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    OWNER: "${{ github.repository_owner }}",
    REPO: "${{ github.event.repository.name }}",
    PARENT: `\${{ needs.${checkJob.name}.outputs.parent_number }}`,
  },
  run: `${scriptCommand(
    "../scripts/dispatch_if_siblings_done.ts",
    toArgv({ repo: "\${OWNER}/\${REPO}", parent: "\${PARENT}" } satisfies DispatchIfSiblingsDoneArgs),
  )}
`,
});

const aggregateJob = new NormalJob("aggregate", {
  "runs-on": "ubuntu-latest",
  if: `needs.${checkJob.name}.outputs.is_sub_issue == 'true' && needs.${checkJob.name}.outputs.closed_via_pr != 'true'`,
})
  .needs([checkJob])
  .addSteps([new ActionsCheckoutV4({}), new SetupBunAction(), aggregateStep]);

export const atomaSubIssueClosed = new Workflow("atoma-sub-issue-closed", {
  name: "Atoma Sub-Issue Closed",
  on: {
    issues: { types: ["closed"] },
  },
  permissions: {
    actions: "write",
    issues: "write",
    "pull-requests": "write",
    contents: "write",
  },
}).addJobs([checkJob, aggregateJob]);

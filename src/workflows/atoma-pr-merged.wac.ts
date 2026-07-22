import { Workflow, NormalJob } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { TypedOutputsStep } from "./actions/base.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { toArgv } from "../scripts/lib/cli.ts";
import type { ResolveOrchestratorParentArgs } from "../scripts/resolve_orchestrator_parent.ts";
import type { AggregateSubIssuesArgs } from "../scripts/aggregate_sub_issues.ts";
// Path-validation-only import: parse_pr_metadata.ts exports no Args/Env type
// (it reads PR_BODY/PR_NUMBER from env and writes $GITHUB_OUTPUT directly),
// so this exists solely to make a renamed/deleted script fail
// `bun run typecheck` at the `scriptCommand()` call site below.
import type * as ParsePrMetadata from "../scripts/parse_pr_metadata.ts";

// Detect PR merges and aggregate sub-issue results.
// Uses pull_request_target so GITHUB_TOKEN-created PR merges are detected.
//
// This is the PRIMARY mechanism for sub-issue aggregation. It fires reliably
// regardless of who/what merged the PR. The `issues: closed` event that also
// fires when the merge auto-closes the linked issue is handled by
// atoma-sub-issue-closed.wac.ts, which explicitly skips issues closed via a
// merged PR (see its "Check if closed via a merged PR" step) to avoid
// dispatching the orchestrator twice for the same completion.

const parseMetadataStep = new TypedOutputsStep(
  {
    name: "Parse parent-issue / sub-issue metadata from PR body",
    id: "parse-metadata",
    shell: "bash",
    env: {
      PR_BODY: "${{ github.event.pull_request.body }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
    },
    run: `${scriptCommand("../scripts/parse_pr_metadata.ts")}\n`,
  },
  ["parent_number", "sub_number"] as const,
);

const parseJob = new NormalJob("parse", {
  "runs-on": "ubuntu-latest",
  if: "github.event.pull_request.merged == true",
  outputs: {
    parent_issue: parseMetadataStep.outputs.parent_number,
    sub_issue: parseMetadataStep.outputs.sub_number,
  },
}).addSteps([new ActionsCheckoutV4({}), new SetupBunAction(), parseMetadataStep]);

const resolveStep = new TypedOutputsStep(
  {
    name: "Resolve orchestrator parent via GraphQL parent field",
    id: "resolve",
    shell: "bash",
    env: {
      GH_TOKEN: "${{ github.token }}",
      REPO: "${{ github.repository }}",
      SUB: `\${{ needs.${parseJob.name}.outputs.sub_issue }}`,
    },
    run: `PARENT=$(${scriptCommand("../scripts/resolve_orchestrator_parent.ts", toArgv({ repo: "\${REPO}", sub: "\${SUB}" } satisfies ResolveOrchestratorParentArgs))})
echo "parent_issue=\${PARENT}" >> "$GITHUB_OUTPUT"
`,
  },
  ["parent_issue"] as const,
);

const resolveParentJob = new NormalJob("resolve-parent", {
  "runs-on": "ubuntu-latest",
  if: `needs.${parseJob.name}.outputs.sub_issue != ''`,
  outputs: {
    parent_issue: resolveStep.outputs.parent_issue,
  },
})
  .needs([parseJob])
  .addSteps([new SetupBunAction(), resolveStep]);

const notifyParentJob = new NormalJob("notify-parent", {
  "runs-on": "ubuntu-latest",
  if: `needs.${resolveParentJob.name}.outputs.parent_issue != ''`,
})
  .needs([resolveParentJob, parseJob])
  .addStep(
    new TypedOutputsStep({
      name: "Comment on parent issue",
      shell: "bash",
      env: {
        GH_TOKEN: "${{ github.token }}",
        REPO: "${{ github.repository }}",
        PARENT: `\${{ needs.${resolveParentJob.name}.outputs.parent_issue }}`,
        PR_NUMBER: "${{ github.event.pull_request.number }}",
        PR_TITLE: "${{ github.event.pull_request.title }}",
        PR_URL: "${{ github.event.pull_request.html_url }}",
      },
      run: `gh issue comment "$PARENT" --repo "$REPO" --body \\
  "PR #\${PR_NUMBER} merged: \${PR_TITLE} (\${PR_URL})"
`,
    }),
  );

const aggregateStep = new TypedOutputsStep({
  name: "Aggregate sub-issue results",
  shell: "bash",
  env: {
    OWNER: "${{ github.repository_owner }}",
    REPO: "${{ github.event.repository.name }}",
    PARENT: `\${{ needs.${resolveParentJob.name}.outputs.parent_issue }}`,
    CLOSED_NUM: `\${{ needs.${parseJob.name}.outputs.sub_issue }}`,
  },
  run: `${scriptCommand("../scripts/aggregate_sub_issues.ts", toArgv({ repo: "\${OWNER}/\${REPO}", parent: "\${PARENT}", "closed-num": "\${CLOSED_NUM}" } satisfies AggregateSubIssuesArgs))}
`,
});

const aggregateSubIssuesJob = new NormalJob("aggregate-sub-issues", {
  "runs-on": "ubuntu-latest",
  if: `needs.${resolveParentJob.name}.outputs.parent_issue != ''`,
  env: {
    GH_TOKEN: "${{ github.token }}",
  },
})
  .needs([resolveParentJob, parseJob])
  .addSteps([
    new ActionsCheckoutV4({}),
    // Required below: aggregate_sub_issues.ts (which in turn shells out to
    // check_open_siblings.ts / inject_sub_results.ts / resolve_notify.ts) is
    // run via `bun run` -- not preinstalled on GitHub-hosted runners.
    new SetupBunAction(),
    aggregateStep,
  ]);

export const atomaPrMerged = new Workflow("atoma-pr-merged", {
  name: "Atoma PR Merged",
  on: {
    pull_request_target: { types: ["closed"] },
  },
  permissions: {
    actions: "write",
    issues: "write",
    "pull-requests": "read",
    contents: "write",
  },
}).addJobs([parseJob, resolveParentJob, notifyParentJob, aggregateSubIssuesJob]);

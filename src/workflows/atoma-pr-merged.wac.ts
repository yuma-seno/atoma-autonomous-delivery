import { Workflow } from "@github-actions-workflow-ts/lib";
import type { PullRequestClosedEvent } from "@octokit/webhooks-types";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { DefinedJob, TypedOutputsStep } from "./actions/base.ts";
import { githubEvent, githubEventRaw } from "./actions/github-context.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { scriptCommand, scriptCommandWithArgs } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { ref as resolveOrchestratorParentRef } from "../scripts/resolve_orchestrator_parent.ts";
import { ref as aggregateSubIssuesRef } from "../scripts/aggregate_sub_issues.ts";
import { ref as parsePrMetadataRef } from "../scripts/parse_pr_metadata.ts";

// Detect PR merges and aggregate sub-issue results.
// Uses pull_request_target so GITHUB_TOKEN-created PR merges are detected.
//
// This is the PRIMARY mechanism for sub-issue aggregation. It fires reliably
// regardless of who/what merged the PR. The `issues: closed` event that also
// fires when the merge auto-closes the linked issue is handled by
// atoma-sub-issue-closed.wac.ts, which explicitly skips issues closed via a
// merged PR (see its "Check if closed via a merged PR" step) to avoid
// dispatching the orchestrator twice for the same completion.
//
// Job graph:
//   parse --> resolve-parent --> notify-parent
//                             \-> aggregate-sub-issues

const parseMetadataStep = new TypedOutputsStep(
  {
    name: "Parse parent-issue / sub-issue metadata from PR body",
    id: "parse-metadata",
    shell: "bash",
    env: {
      PR_BODY: githubEvent<PullRequestClosedEvent>((e) => e.pull_request.body),
      PR_NUMBER: githubEvent<PullRequestClosedEvent>((e) => e.pull_request.number),
    },
    run: `${scriptCommand(parsePrMetadataRef)}\n`,
  },
  ["parent_number", "sub_number"] as const,
);

const parseJob = new DefinedJob(
  "parse",
  {
    "runs-on": "ubuntu-latest",
    if: `${githubEventRaw<PullRequestClosedEvent>((e) => e.pull_request.merged)} == true`,
    outputs: {
      parent_issue: parseMetadataStep.outputs.parent_number,
      sub_issue: parseMetadataStep.outputs.sub_number,
    },
  },
  [new ActionsCheckoutV4({}), new SetupBunAction({ name: "Setup Bun" }), parseMetadataStep],
);

const resolveStep = new TypedOutputsStep(
  {
    name: "Resolve orchestrator parent via GraphQL parent field",
    id: "resolve",
    shell: "bash",
    env: {
      GH_TOKEN: "${{ github.token }}",
      REPO: "${{ github.repository }}",
      SUB: parseJob.outputs.sub_issue,
    },
    run: `PARENT=$(${scriptCommandWithArgs(resolveOrchestratorParentRef, { repo: "\${REPO}", sub: "\${SUB}" })})
echo "parent_issue=\${PARENT}" >> "$GITHUB_OUTPUT"
`,
  },
  ["parent_issue"] as const,
);

const resolveParentJob = new DefinedJob(
  "resolve-parent",
  {
    "runs-on": "ubuntu-latest",
    if: `${parseJob.rawOutputs.sub_issue} != ''`,
    outputs: {
      parent_issue: resolveStep.outputs.parent_issue,
    },
  },
  [new SetupBunAction({ name: "Setup Bun" }), resolveStep],
  [parseJob],
);

// Both terminal jobs below depend on the exact same pair -- resolve-parent
// (for the resolved parent issue number) and parse (for the raw sub-issue
// number) -- so this is the one place that lists that dependency.
const NOTIFY_AND_AGGREGATE_NEEDS = [resolveParentJob, parseJob];

export const atomaPrMerged = new Workflow("atoma-pr-merged", {
  name: "Atoma PR Merged",
  on: {
    pull_request_target: { types: ["closed"] },
  },
  permissions: { ...ATOMA_WORKFLOW_PERMISSIONS, "pull-requests": "read" },
}).addJobs([
  parseJob,
  resolveParentJob,
  new DefinedJob(
    "notify-parent",
    {
      "runs-on": "ubuntu-latest",
      if: `${resolveParentJob.rawOutputs.parent_issue} != ''`,
    },
    [
      new TypedOutputsStep({
        name: "Comment on parent issue",
        shell: "bash",
        env: {
          GH_TOKEN: "${{ github.token }}",
          REPO: "${{ github.repository }}",
          PARENT: resolveParentJob.outputs.parent_issue,
          PR_NUMBER: githubEvent<PullRequestClosedEvent>((e) => e.pull_request.number),
          PR_TITLE: githubEvent<PullRequestClosedEvent>((e) => e.pull_request.title),
          PR_URL: githubEvent<PullRequestClosedEvent>((e) => e.pull_request.html_url),
        },
        run: `gh issue comment "$PARENT" --repo "$REPO" --body \\
  "PR #\${PR_NUMBER} merged: \${PR_TITLE} (\${PR_URL})"
`,
      }),
    ],
    NOTIFY_AND_AGGREGATE_NEEDS,
  ),
  new DefinedJob(
    "aggregate-sub-issues",
    {
      "runs-on": "ubuntu-latest",
      if: `${resolveParentJob.rawOutputs.parent_issue} != ''`,
      env: {
        GH_TOKEN: "${{ github.token }}",
      },
    },
    [
      new ActionsCheckoutV4({}),
      // Required below: aggregate_sub_issues.ts (which uses shared logic
      // from lib/aggregation.ts, lib/sibling-check.ts, lib/notify.ts) is
      // run via `bun run` -- not preinstalled on GitHub-hosted runners.
      new SetupBunAction({ name: "Setup Bun" }),
      new TypedOutputsStep({
        name: "Aggregate sub-issue results",
        shell: "bash",
        env: {
          OWNER: "${{ github.repository_owner }}",
          REPO: githubEvent<PullRequestClosedEvent>((e) => e.repository.name),
          PARENT: resolveParentJob.outputs.parent_issue,
          CLOSED_NUM: parseJob.outputs.sub_issue,
        },
        run: `${scriptCommandWithArgs(aggregateSubIssuesRef, { repo: "\${OWNER}/\${REPO}", parent: "\${PARENT}", "closed-num": "\${CLOSED_NUM}" })}
`,
      }),
    ],
    NOTIFY_AND_AGGREGATE_NEEDS,
  ),
]);

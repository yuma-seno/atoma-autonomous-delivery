import { Workflow } from "@github-actions-workflow-ts/lib";
import type { IssueCommentCreatedEvent } from "@octokit/webhooks-types";
import { ParseCommentCommandAction } from "./actions/atoma.ts";
import { DefinedJob, TypedOutputsStep } from "./actions/base.ts";
import { githubEvent, githubEventRaw } from "./actions/github-context.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { atomaRunnerWorkflow } from "./atoma-runner.wac.ts";

// Invoke agents via /agent-name slash command in issue/PR comments.
// Restricted to OWNER/MEMBER/COLLABORATOR.
//
// Job graph:
//   parse --> run (atoma-runner.yml, reusable)
const parseCommandStep = new ParseCommentCommandAction({
  name: "Parse slash command",
  id: "command",
  with: { body: githubEvent<IssueCommentCreatedEvent>((e) => e.comment.body) },
});

const targetStep = new TypedOutputsStep(
  {
    name: "Resolve target context",
    id: "target",
    shell: "bash",
    env: {
      NUMBER: githubEvent<IssueCommentCreatedEvent>((e) => e.issue.number),
      IS_PR: `\${{ toJSON(${githubEventRaw<IssueCommentCreatedEvent>((e) => e.issue.pull_request)} != null) }}`,
      NOTIFY: githubEvent<IssueCommentCreatedEvent>((e) => e.comment.user.login),
    },
    run: `echo "number=\${NUMBER}" >> "$GITHUB_OUTPUT"
if [ "$IS_PR" = "true" ]; then
  echo "type=pr" >> "$GITHUB_OUTPUT"
else
  echo "type=issue" >> "$GITHUB_OUTPUT"
fi
echo "notify=\${NOTIFY}" >> "$GITHUB_OUTPUT"
`,
  },
  ["number", "type", "notify"] as const,
);

const parseJob = new DefinedJob(
  "parse",
  {
    "runs-on": "ubuntu-latest",
    if:
      `(${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.user.type)} == 'Bot' &&\n` +
      ` contains(${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.body)}, 'atoma:dispatch')) ||\n` +
      `(${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.user.type)} != 'Bot' &&\n` +
      ` (${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.author_association)} == 'OWNER' ||\n` +
      `  ${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.author_association)} == 'MEMBER' ||\n` +
      `  ${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.author_association)} == 'COLLABORATOR'))`,
    outputs: {
      agent: parseCommandStep.outputs.agent,
      number: targetStep.outputs.number,
      type: targetStep.outputs.type,
      notify: targetStep.outputs.notify,
    },
  },
  [parseCommandStep, targetStep],
);

const runJob = atomaRunnerWorkflow.call("run", {
  needs: [parseJob],
  if: `${parseJob.rawOutputs.agent} != ''`,
  with: {
    agent: parseJob.outputs.agent,
    number: parseJob.outputs.number,
    type: parseJob.outputs.type,
    notify: parseJob.outputs.notify,
  },
  secrets: "inherit",
});

export const atomaManualComment = new Workflow("atoma-manual-comment", {
  name: "Atoma Manual Comment",
  on: {
    issue_comment: { types: ["created"] },
  },
  permissions: ATOMA_WORKFLOW_PERMISSIONS,
}).addJobs([parseJob, runJob]);

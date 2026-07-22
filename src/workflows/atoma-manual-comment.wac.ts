import { Workflow, NormalJob, ReusableWorkflowCallJob } from "@github-actions-workflow-ts/lib";
import { ParseCommentCommandAction } from "./actions/atoma.ts";
import { TypedOutputsStep } from "./actions/base.ts";

// Invoke agents via /agent-name slash command in issue/PR comments.
// Restricted to OWNER/MEMBER/COLLABORATOR.
const parseCommandStep = new ParseCommentCommandAction({
  name: "Parse slash command",
  id: "command",
  with: { body: "${{ github.event.comment.body }}" },
});

const targetStep = new TypedOutputsStep(
  {
    name: "Resolve target context",
    id: "target",
    shell: "bash",
    env: {
      NUMBER: "${{ github.event.issue.number }}",
      IS_PR: "${{ toJSON(github.event.issue.pull_request != null) }}",
      NOTIFY: "${{ github.event.comment.user.login }}",
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

const parseJob = new NormalJob("parse", {
  "runs-on": "ubuntu-latest",
  if:
    "(github.event.comment.user.type == 'Bot' &&\n" +
    " contains(github.event.comment.body, 'atoma:dispatch')) ||\n" +
    "(github.event.comment.user.type != 'Bot' &&\n" +
    " (github.event.comment.author_association == 'OWNER' ||\n" +
    "  github.event.comment.author_association == 'MEMBER' ||\n" +
    "  github.event.comment.author_association == 'COLLABORATOR'))",
  outputs: {
    agent: parseCommandStep.outputs.agent,
    number: targetStep.outputs.number,
    type: targetStep.outputs.type,
    notify: targetStep.outputs.notify,
  },
}).addSteps([parseCommandStep, targetStep]);

const runJob = new ReusableWorkflowCallJob("run", {
  if: `needs.${parseJob.name}.outputs.agent != ''`,
  uses: "./.github/workflows/atoma-runner.yml",
  with: {
    agent: `\${{ needs.${parseJob.name}.outputs.agent }}`,
    number: `\${{ needs.${parseJob.name}.outputs.number }}`,
    type: `\${{ needs.${parseJob.name}.outputs.type }}`,
    notify: `\${{ needs.${parseJob.name}.outputs.notify }}`,
  },
  secrets: "inherit",
}).needs([parseJob]);

export const atomaManualComment = new Workflow("atoma-manual-comment", {
  name: "Atoma Manual Comment",
  on: {
    issue_comment: { types: ["created"] },
  },
  permissions: {
    actions: "write",
    issues: "write",
    "pull-requests": "write",
    contents: "write",
  },
}).addJobs([parseJob, runJob]);

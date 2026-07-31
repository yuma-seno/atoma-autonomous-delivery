import { Workflow } from "@github-actions-workflow-ts/lib";
import type { IssueCommentCreatedEvent } from "@octokit/webhooks-types";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { startJob, TypedOutputsStep } from "./actions/base.ts";
import { githubEvent, githubEventRaw, isRepositoryMember } from "./actions/github-context.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { scriptCommand, scriptCommandWithArgs } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { dispatchToAtomaRunner } from "./atoma-runner.wac.ts";
import { ref as parseCommentCommandRef } from "../scripts/parse_comment_command.ts";
import { ref as guardCommentRef } from "../scripts/guard_comment_during_run.ts";

// Invoke agents via /agent-name slash command in issue/PR comments.
// Slash-command DISPATCH is restricted to OWNER/MEMBER/COLLABORATOR (see
// parseCommandStep's own `if:` below), but the in-progress GUARD (see
// guardStep) runs for every human comment regardless of association --
// nobody's comment should sit unseen (or race a dispatch) while an Atoma
// run is actively working on this issue/PR.
//
// Job graph:
//   parse --> run (atoma-runner.yml, reusable)

// Bot comments are never guarded (Atoma's own comments, e.g. dispatch
// confirmations, must never be self-deleted) -- only ever relevant for a
// human-authored comment.
const IS_HUMAN_COMMENT = `${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.user.type)} != 'Bot'`;

const guardStep = new TypedOutputsStep(
  {
    name: "Guard: reject comment while atoma/in-progress",
    id: "guard",
    if: IS_HUMAN_COMMENT,
    shell: "bash",
    env: {
      GH_TOKEN: "${{ github.token }}",
      NUMBER: githubEvent<IssueCommentCreatedEvent>((e) => e.issue.number),
      COMMENT_ID: githubEvent<IssueCommentCreatedEvent>((e) => e.comment.id),
      COMMENTER: githubEvent<IssueCommentCreatedEvent>((e) => e.comment.user.login),
    },
    run: `${scriptCommandWithArgs(guardCommentRef, { number: "\${NUMBER}", "comment-id": "\${COMMENT_ID}", commenter: "\${COMMENTER}" })}\n`,
  },
  ["blocked"] as const,
);

// A slash command dispatches only for a repository member, or for Atoma's own
// dispatch marker. The membership half now shares `isRepositoryMember` with every
// other entry point, so the trust boundary has one definition rather than an
// inline expression here and nothing anywhere else.
//
// The job itself still runs for non-qualifying humans, but only so guardStep can
// do its job; this step refuses to parse or dispatch for them.
const PARSE_ALLOWED =
  `(${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.user.type)} == 'Bot' &&\n` +
  ` contains(${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.body)}, 'atoma:dispatch')) ||\n` +
  `(${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.user.type)} != 'Bot' &&\n` +
  ` ${isRepositoryMember(githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.author_association))})`;

const parseCommandStep = new TypedOutputsStep(
  {
    name: "Parse slash command",
    id: "command",
    if: `(${PARSE_ALLOWED}) && steps.guard.outputs.blocked != 'true'`,
    shell: "bash",
    env: {
      ATOMA_COMMENT_BODY: githubEvent<IssueCommentCreatedEvent>((e) => e.comment.body),
    },
    run: `${scriptCommand(parseCommentCommandRef)}\n`,
  },
  ["matched", "agent", "session_mode", "error"] as const,
);

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

const commandErrorStep = new TypedOutputsStep({
  name: "Report invalid slash command",
  if: `${parseCommandStep.rawOutputs.error} != ''`,
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: targetStep.outputs.number,
    ERROR: parseCommandStep.outputs.error,
  },
  run: `gh issue comment "\${NUMBER}" --body "Atoma command error: \${ERROR}"
`,
});

export const atomaManualComment = new Workflow("atoma-manual-comment", {
  name: "Atoma Manual Comment",
  on: {
    issue_comment: { types: ["created"] },
  },
  permissions: ATOMA_WORKFLOW_PERMISSIONS,
}).addJobs(
  startJob(
    "parse",
    {
      "runs-on": "ubuntu-latest",
      // Broader than PARSE_ALLOWED on purpose: this job now also needs to
      // run for ANY human comment (regardless of association) so guardStep
      // can reject it while atoma/in-progress is active -- actual
      // parsing/dispatch stays restricted to PARSE_ALLOWED via
      // parseCommandStep's own `if:` above.
      if: `(${IS_HUMAN_COMMENT}) || (${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.user.type)} == 'Bot' && contains(${githubEventRaw<IssueCommentCreatedEvent>((e) => e.comment.body)}, 'atoma:dispatch'))`,
      outputs: {
        agent: parseCommandStep.outputs.agent,
        session_mode: parseCommandStep.outputs.session_mode,
        number: targetStep.outputs.number,
        type: targetStep.outputs.type,
        notify: targetStep.outputs.notify,
      },
    },
    [new ActionsCheckoutV4({}), new SetupBunAction({ name: "Setup Bun" }), guardStep, parseCommandStep, targetStep, commandErrorStep],
  )
    .then((parseJob) => dispatchToAtomaRunner(parseJob, "inherit", parseJob.outputs.session_mode))
    .jobs(),
);

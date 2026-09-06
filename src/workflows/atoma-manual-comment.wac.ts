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
import { ref as requestStopRef } from "../scripts/request_stop.ts";
import { ref as resolveResumeAgentRef } from "../scripts/resolve_resume_agent.ts";

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
    // No longer conditioned on the guard, because the guard now reads this step. What
    // the guard suppresses is the dispatch, which is what it was protecting all along
    // -- see `dispatchStep`.
    if: PARSE_ALLOWED,
    shell: "bash",
    env: {
      ATOMA_COMMENT_BODY: githubEvent<IssueCommentCreatedEvent>((e) => e.comment.body),
    },
    run: `${scriptCommand(parseCommentCommandRef)}\n`,
  },
  ["matched", "agent", "control", "session_mode", "error"] as const,
);

/**
 * The guard, and the one command it must not eat.
 *
 * Every other slash command asks for work to START, and starting a second run on an
 * issue that already has one is the race this guard exists to prevent. `/stop` is the
 * opposite: its entire meaning is "act on the run that is happening right now", so a
 * guard that deleted it would make it unusable at exactly the moment it is for.
 *
 * The exemption is one command wide on purpose. Nothing else earns it.
 */
const guardStep = new TypedOutputsStep(
  {
    name: "Guard: reject comment while atoma/in-progress",
    id: "guard",
    if: `(${IS_HUMAN_COMMENT}) && ${parseCommandStep.rawOutputs.control} != 'stop'`,
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

/**
 * `/stop`: take the comment out of the thread and leave the request the run polls for.
 *
 * See `request_stop.ts`. Nothing here waits for the run to actually stop -- that is a
 * different job on a different machine, and the notice saying it stopped is posted by
 * that job, which is the only one that knows.
 */
const stopStep = new TypedOutputsStep({
  name: "Request a stop",
  if: `${parseCommandStep.rawOutputs.control} == 'stop'`,
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: githubEvent<IssueCommentCreatedEvent>((e) => e.issue.number),
    COMMENT_ID: githubEvent<IssueCommentCreatedEvent>((e) => e.comment.id),
    COMMENTER: githubEvent<IssueCommentCreatedEvent>((e) => e.comment.user.login),
  },
  run: `${scriptCommandWithArgs(requestStopRef, {
    number: "\${NUMBER}",
    "comment-id": "\${COMMENT_ID}",
    commenter: "\${COMMENTER}",
  })}\n`,
});

/**
 * `/resume`: fill in the agent name from what last ran here, and dispatch it.
 *
 * A step and not part of the parser, because the answer is in the thread rather than
 * in the comment -- see `resolve_resume_agent.ts`.
 */
const resumeStep = new TypedOutputsStep(
  {
    name: "Resolve the agent to resume",
    id: "resume",
    if: `${parseCommandStep.rawOutputs.control} == 'resume'`,
    shell: "bash",
    env: {
      GH_TOKEN: "${{ github.token }}",
      NUMBER: githubEvent<IssueCommentCreatedEvent>((e) => e.issue.number),
    },
    run: `${scriptCommandWithArgs(resolveResumeAgentRef, { number: "\${NUMBER}" })}\n`,
  },
  ["agent"] as const,
);

/**
 * The one agent name this job dispatches, from whichever command produced it.
 *
 * Also where the guard finally takes effect. It used to work by suppressing the
 * parse, which is no longer possible now that the guard reads the parse -- so what it
 * suppresses is the dispatch, which is the thing it was protecting all along.
 */
const dispatchStep = new TypedOutputsStep(
  {
    name: "Decide what to dispatch",
    id: "dispatch",
    shell: "bash",
    env: {
      FROM_COMMAND: parseCommandStep.outputs.agent,
      FROM_RESUME: resumeStep.outputs.agent,
      BLOCKED: guardStep.outputs.blocked,
    },
    run: `if [ "$BLOCKED" = "true" ]; then
  AGENT=""
else
  AGENT="\${FROM_COMMAND:-\${FROM_RESUME}}"
fi
echo "agent=\${AGENT}" >> "$GITHUB_OUTPUT"
echo "dispatching: \${AGENT:-nothing}"
`,
  },
  ["agent"] as const,
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
        agent: dispatchStep.outputs.agent,
        session_mode: parseCommandStep.outputs.session_mode,
        number: targetStep.outputs.number,
        type: targetStep.outputs.type,
        notify: targetStep.outputs.notify,
      },
    },
    [
      new ActionsCheckoutV4({}),
      new SetupBunAction({ name: "Setup Bun" }),
      // Parse first: the guard below has to know whether this is the one command it
      // must let through.
      parseCommandStep,
      guardStep,
      targetStep,
      stopStep,
      resumeStep,
      dispatchStep,
      commandErrorStep,
    ],
  )
    .then((parseJob) => dispatchToAtomaRunner(parseJob, "inherit", parseJob.outputs.session_mode))
    .jobs(),
);

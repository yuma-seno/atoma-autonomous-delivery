import { Workflow } from "@github-actions-workflow-ts/lib";
import type { PullRequestOpenedEvent, PullRequestReadyForReviewEvent, PullRequestSynchronizeEvent } from "@octokit/webhooks-types";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { DefinedJob, TypedOutputsStep } from "./actions/base.ts";
import { githubEvent, githubEventRaw } from "./actions/github-context.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { scriptCommand } from "./actions/script-call.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { atomaRunnerWorkflow } from "./atoma-runner.wac.ts";
import { ref as extractNotifyTagRef } from "../scripts/extract_notify_tag.ts";
import { ref as matchTriggerRef, type MatchTriggerEnv } from "../scripts/match_trigger.ts";

// Matches this workflow's own `on.pull_request_target.types` below -- used to
// type-check every `githubEvent()`/`githubEventRaw()` call in this file
// against the actual payload shape for exactly these 3 actions.
type AutoTriggerEvent = PullRequestOpenedEvent | PullRequestSynchronizeEvent | PullRequestReadyForReviewEvent;

// Generic workflow triggered by GitHub events.
// Uses pull_request_target (NOT pull_request) because GITHUB_TOKEN-created PRs
// trigger the event but GitHub suppresses workflow runs for pull_request events.
// pull_request_target runs in the base repo context with full write permissions.
//
// pull_request_review is handled in a separate workflow (atoma-pr-review.wac.ts)
// because pull_request_target and pull_request_review cannot be combined.
//
// Job graph:
//   route --> run (atoma-runner.yml, reusable)

const contextStep = new TypedOutputsStep(
  {
    name: "Determine PR number from event context",
    id: "context",
    shell: "bash",
    // This workflow's `on:` is exclusively `pull_request_target` (see below)
    // -- unlike a generic issues-or-PR handler, `github.event.pull_request`
    // is therefore always present, so there is no `github.event.issue`
    // fallback branch to type (there never was a real `issue`-only case to
    // handle here; typing this against the real payload is what surfaced
    // that the old if/else's `else` branch was dead).
    run: `echo "number=${githubEvent<AutoTriggerEvent>((e) => e.pull_request.number)}" >> "$GITHUB_OUTPUT"
echo "type=pr" >> "$GITHUB_OUTPUT"
`,
  },
  ["number", "type"] as const,
);

const notifyStep = new TypedOutputsStep(
  {
    name: "Resolve notify login from PR body tag",
    id: "notify",
    shell: "bash",
    env: { PR_BODY: githubEvent<AutoTriggerEvent>((e) => e.pull_request.body) },
    run: `${scriptCommand(extractNotifyTagRef)}\n`,
  },
  ["notify"] as const,
);

const matchStep = new TypedOutputsStep(
  {
    name: "Match event to agent from config.json",
    id: "match",
    shell: "bash",
    env: {
      EVENT_TYPE: `\${{ github.event_name }}.\${{ ${githubEventRaw<AutoTriggerEvent>((e) => e.action)} }}`,
      // `.review` doesn't exist on any pull_request_target payload (it's
      // exclusive to pull_request_review events, handled by the separate
      // atoma-pr-review.wac.ts) -- this always resolves empty for this
      // workflow, which `MatchTriggerEnv`'s optional `REVIEW_STATE` allows
      // for. Left as a plain string since there is no real field of this
      // event type to type-check it against.
      REVIEW_STATE: "${{ github.event.review.state }}",
      IS_DRAFT: githubEvent<AutoTriggerEvent>((e) => e.pull_request.draft),
    } satisfies MatchTriggerEnv,
    run: `AGENT=$(${scriptCommand(matchTriggerRef)} 2>/dev/null || true)
if [ -n "\${AGENT}" ]; then
  echo "Matched agent: \${AGENT}"
  echo "agent=\${AGENT}" >> "$GITHUB_OUTPUT"
  echo "number=${contextStep.outputs.number}" >> "$GITHUB_OUTPUT"
  echo "type=${contextStep.outputs.type}" >> "$GITHUB_OUTPUT"
fi
`,
  },
  ["agent", "number", "type"] as const,
);

const routeJob = new DefinedJob(
  "route",
  {
    "runs-on": "ubuntu-latest",
    outputs: {
      agent: matchStep.outputs.agent,
      number: matchStep.outputs.number,
      type: matchStep.outputs.type,
      notify: notifyStep.outputs.notify,
    },
  },
  [
    new ActionsCheckoutV4({}),
    // Required by the "Match event to agent" step below, which runs
    // match_trigger.ts via `bun run` -- not preinstalled on GitHub-hosted
    // runners.
    new SetupBunAction(),
    contextStep,
    notifyStep,
    matchStep,
  ],
);

const runJob = atomaRunnerWorkflow.call("run", {
  needs: [routeJob],
  if: `${routeJob.rawOutputs.agent} != ''`,
  with: {
    agent: routeJob.outputs.agent,
    number: routeJob.outputs.number,
    type: routeJob.outputs.type,
    notify: routeJob.outputs.notify,
  },
  secrets: "inherit",
});

export const atomaAutoTrigger = new Workflow("atoma-auto-trigger", {
  name: "Atoma Auto Trigger",
  on: {
    pull_request_target: { types: ["opened", "synchronize", "ready_for_review"] },
  },
  permissions: ATOMA_WORKFLOW_PERMISSIONS,
}).addJobs([routeJob, runJob]);

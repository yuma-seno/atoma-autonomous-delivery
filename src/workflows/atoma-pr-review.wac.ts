import { Workflow } from "@github-actions-workflow-ts/lib";
import type { PullRequestReviewSubmittedEvent } from "@octokit/webhooks-types";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { startJob } from "./actions/base.ts";
import { githubEvent, githubEventRaw, isRepositoryMember } from "./actions/github-context.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { routeByTriggerMatch } from "./actions/route-by-trigger.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { dispatchToAtomaRunner } from "./atoma-runner.wac.ts";

// Separate workflow for pull_request_review events.
// Cannot be combined with pull_request_target in atoma-auto-trigger.wac.ts.
//
// The routing itself -- read the number, resolve the notify login, match the
// agent -- is `routeByTriggerMatch`, shared with atoma-auto-trigger. Only the
// event type and the fields read from its payload differ, and those stay here so
// they are still checked against this workflow's own declared event.
//
// Job graph:
//   route --> run (atoma-runner.yml, reusable)

const route = routeByTriggerMatch({
  prNumber: githubEvent<PullRequestReviewSubmittedEvent>((e) => e.pull_request.number),
  prBody: githubEvent<PullRequestReviewSubmittedEvent>((e) => e.pull_request.body),
  matchEnv: {
    EVENT_TYPE: `\${{ github.event_name }}.\${{ ${githubEventRaw<PullRequestReviewSubmittedEvent>((e) => e.action)} }}`,
    REVIEW_STATE: githubEvent<PullRequestReviewSubmittedEvent>((e) => e.review.state),
  },
});

export const atomaPrReview = new Workflow("atoma-pr-review", {
  name: "Atoma PR Review",
  on: {
    pull_request_review: { types: ["submitted"] },
  },
  permissions: ATOMA_WORKFLOW_PERMISSIONS,
}).addJobs(
  startJob(
    "route",
    {
      "runs-on": "ubuntu-latest",
      // Only a repository member's review starts an agent. Otherwise anyone could
      // dispatch the engineer by submitting REQUEST_CHANGES on a pull request.
      if: isRepositoryMember(githubEventRaw<PullRequestReviewSubmittedEvent>((e) => e.review.author_association)),
      outputs: route.outputs,
    },
    [
      new ActionsCheckoutV4({}),
      // Required by the "Match event to agent" step below, which runs
      // match_trigger.ts via `bun run` -- not preinstalled on GitHub-hosted
      // runners.
      new SetupBunAction({ name: "Setup Bun" }),
      ...route.steps,
    ],
  )
    // `secrets: inherit`, like every other routing workflow. Its absence was
    // preserved from the original hand-written YAML as if deliberate, but a
    // reusable workflow called without it receives no secrets at all: the runner
    // exports the provider key from `secrets.OPENAI_API_KEY`/`ANTHROPIC_API_KEY`,
    // so the agent started with no credentials and the run failed on its first
    // inference call.
    //
    // The path that reaches here is a human submitting REQUEST_CHANGES, which
    // `auto_triggers` maps to the engineer. Agent-to-agent review never came
    // through it — `submit_pr_review` dispatches nothing and the handoff rides the
    // `/engineer` directive instead — so the only route through this workflow was
    // the broken one.
    .then((routeJob) => dispatchToAtomaRunner(routeJob, "inherit"))
    .jobs(),
);

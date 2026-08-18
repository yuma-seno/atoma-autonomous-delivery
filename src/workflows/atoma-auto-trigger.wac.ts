import { Workflow } from "@github-actions-workflow-ts/lib";
import type { PullRequestOpenedEvent, PullRequestReadyForReviewEvent, PullRequestSynchronizeEvent } from "@octokit/webhooks-types";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { startJob } from "./actions/base.ts";
import { githubEvent, githubEventRaw, isRepositoryMember } from "./actions/github-context.ts";
import { ATOMA_WORKFLOW_PERMISSIONS } from "./actions/permissions.ts";
import { routeByTriggerMatch } from "./actions/route-by-trigger.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { dispatchToAtomaRunner } from "./atoma-runner.wac.ts";

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
// because pull_request_target and pull_request_review cannot be combined. The
// routing steps themselves are shared with it via `routeByTriggerMatch`; only
// the event type and the payload fields read from it live here, so they stay
// checked against this workflow's own declared event.
//
// Job graph:
//   route --> run (atoma-runner.yml, reusable)

const route = routeByTriggerMatch({
  prNumber: githubEvent<AutoTriggerEvent>((e) => e.pull_request.number),
  prBody: githubEvent<AutoTriggerEvent>((e) => e.pull_request.body),
  matchEnv: {
    EVENT_TYPE: `\${{ github.event_name }}.\${{ ${githubEventRaw<AutoTriggerEvent>((e) => e.action)} }}`,
    // `.review` doesn't exist on any pull_request_target payload (it's
    // exclusive to pull_request_review events, handled by the separate
    // atoma-pr-review.wac.ts) -- this always resolves empty for this
    // workflow, which `MatchTriggerEnv`'s optional `REVIEW_STATE` allows
    // for. Left as a plain string since there is no real field of this
    // event type to type-check it against.
    REVIEW_STATE: "${{ github.event.review.state }}",
    IS_DRAFT: githubEvent<AutoTriggerEvent>((e) => e.pull_request.draft),
  },
});

export const atomaAutoTrigger = new Workflow("atoma-auto-trigger", {
  name: "Atoma Auto Trigger",
  on: {
    pull_request_target: { types: ["opened", "synchronize", "ready_for_review"] },
  },
  permissions: ATOMA_WORKFLOW_PERMISSIONS,
}).addJobs(
  startJob(
    "route",
    {
      "runs-on": "ubuntu-latest",
      // Only a repository member's pull request starts an agent. Combined with
      // `pull_request_target`, this is what keeps an outside contributor's code
      // from ever being checked out and run with this repository's credentials.
      if: isRepositoryMember(githubEventRaw<AutoTriggerEvent>((e) => e.pull_request.author_association)),
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
    .then((routeJob) => dispatchToAtomaRunner(routeJob, "inherit"))
    .jobs(),
);

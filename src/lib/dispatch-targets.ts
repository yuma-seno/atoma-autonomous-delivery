/**
 * dispatch-targets.ts — the workflows an agent's own actions have to start.
 *
 * All four exist for one reason: GitHub starts no workflow run for events its
 * own token triggers. An agent opening a pull request fires no
 * `pull_request.opened`; an agent merging fires no `push`. So anything that
 * would have chained off those events has to be dispatched explicitly, and
 * `workflow_dispatch` is the documented exception that still runs.
 *
 * Every one is best-effort. A dispatch that fails must not fail the action that
 * prompted it — a pull request that exists without its CI started is recoverable,
 * one that was never created is not.
 */
import { dispatchWorkflow, gh } from "./gh.ts";
import { getDeployTargets, getTriggerAgent, getWorkflowName } from "./config.ts";
import { dispatchRunner } from "./dispatch.ts";
import { resolveNotify } from "./notify.ts";
import { isIssueBranch } from "./branch-placement.ts";
import { targetsForMerge } from "../domain/deploy-targets.ts";

/**
 * The workflows this template ships, used when a project names none of its own.
 *
 * The shipped ones are the default because they are the arrangement this
 * template is for: a pipeline expressed as commands in config.json, which an
 * agent can write and a workflow file is not. A project that has its own
 * workflows says so in `workflows.ci` / `workflows.cd` and neither of these is
 * consulted.
 *
 * Guessing `ci.yml` instead — a name a repository may or may not use — would
 * dispatch a workflow that does not exist and leave every pull request waiting
 * for a check that never reports.
 */
const DEFAULT_CI_WORKFLOW = "atoma-check.yml";
const DEFAULT_CD_WORKFLOW = "atoma-deploy.yml";

function log(message: string): void {
  console.error(`[atoma-github] ${message}`);
}

/**
 * Hand a new pull request to validation rather than straight to a reviewer.
 *
 * The reviewer used to be dispatched from here, and arrived before CI had a
 * verdict -- so it either reported that it would wait, with nothing able to wake
 * it, or merged without one. Validation runs CI first and dispatches the agent
 * the result calls for: the reviewer when it passes, the engineer when it does
 * not. See `scripts/validate_pull_request.ts`.
 */
export function dispatchPrValidation(repo: string, prNumber: number, branch: string): void {
  const reviewer = getTriggerAgent("pull_request.opened", "reviewer");
  dispatchWorkflow(
    `dispatchPrValidation: validating PR #${prNumber}`,
    "atoma-validate-pr.yml",
    [
      "--repo", repo,
      "-f", `number=${prNumber}`,
      "-f", `branch=${branch}`,
      "-f", `reviewer=${reviewer}`,
      "-f", "engineer=engineer",
    ],
    log,
  );
}

/**
 * After a pull request merges, re-invoke the agent that created it on the linked
 * sub-issue, instead of silently closing that sub-issue here.
 *
 * The agent is named by the `atoma:origin-agent` tag the pull request body
 * carries. Returns whether the dispatch was sent; the caller falls back to
 * closing the issue directly when it was not.
 */
export function dispatchPostMergeAgent(repo: string, subIssueNum: number, agent: string): boolean {
  const notify = resolveNotify(repo, subIssueNum);
  const { code, stdout, stderr } = gh(
    "issue", "comment", String(subIssueNum), "--repo", repo,
    "--body", "Atoma: Your PR was merged. Please confirm completion and close this sub-task.",
  );
  if (code) {
    log(`dispatchPostMergeAgent: could not post trigger comment on #${subIssueNum}: ${stderr || stdout}`);
    return false;
  }
  return dispatchRunner({
    context: `dispatchPostMergeAgent: re-invoking ${agent} on #${subIssueNum} to confirm and close`,
    agent,
    type: "issue",
    number: subIssueNum,
    notify,
    repo,
    log,
  });
}

/** Kick off the CI workflow against a branch, so a fresh agent pull request gets a check run. */
export function dispatchCi(branch: string): boolean {
  return dispatchWorkflow("dispatchCi", getWorkflowName("ci", DEFAULT_CI_WORKFLOW), ["--ref", branch], log);
}

/**
 * Kick off the deployment workflow after a merge.
 *
 * Required, not a nicety: this merge is performed with GITHUB_TOKEN, so it fires
 * no `push` on the base branch and a deployment waiting on that chain never
 * runs.
 *
 * A project either names its own workflow in `workflows.cd`, or declares
 * `deploy.targets` and lets `atoma-deploy.yml` run them. In the second case the
 * decision is made HERE rather than in the workflow: a dispatch that starts a
 * runner only to discover that nothing deploys on merge is a wasted run on every
 * single merge, and this is the one trigger where the question can be answered
 * before starting anything. The tag trigger has no such luxury -- `on:` takes no
 * expression -- so that one filters after the fact.
 *
 * A declaration that does not parse is not this function's to report. It fails
 * loudly inside the deploy run, where the log belongs to the deployment; here it
 * would fail a merge that is otherwise complete.
 */
export function dispatchCd(baseRef: string): boolean {
  // Only a merge that actually lands work deploys. A sub-issue's pull request
  // merges into its parent's branch, which is still in progress — deploying
  // there would ship half a feature, once per child.
  if (isIssueBranch(baseRef)) {
    log(`dispatchCd: merged into ${baseRef}, which is work in progress; not deploying`);
    return false;
  }

  const configured = getWorkflowName("cd");
  if (!configured) {
    const { targets, problems } = getDeployTargets();
    if (problems.length === 0 && targetsForMerge(targets).length === 0) {
      log("dispatchCd: no deploy.targets deploy on merge, and workflows.cd is unset; nothing to dispatch");
      return false;
    }
  }

  const workflow = configured || DEFAULT_CD_WORKFLOW;
  const args = ["--ref", baseRef || "main"];
  // Only the shipped workflow understands why it was started. A project's own
  // deployment workflow gets the bare dispatch it has always got.
  if (!configured) args.push("-f", "trigger=merge");
  return dispatchWorkflow("dispatchCd", workflow, args, log);
}

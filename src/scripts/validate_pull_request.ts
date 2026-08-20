#!/usr/bin/env bun
/**
 * validate_pull_request.ts — runs the repository's CI against an agent's pull
 * request, writes the result where the branch ruleset will look for it, and says
 * who works next.
 *
 * ## Why this exists at all
 *
 * An agent's pull request cannot satisfy a required status check on its own.
 *
 * GitHub changed on 2026-06-11 ("Bot-created pull requests can run workflows if
 * approved"): a workflow triggered by a pull request that the default
 * `GITHUB_TOKEN` created or updated is held for human approval, even on a branch
 * in the same repository. The intent is that generated code should not
 * automatically run workflows that may reach secrets. No setting disables it.
 *
 * So the run that would normally produce the required check sits at
 * `action_required` and never reports. This script dispatches CI itself, waits
 * for it, and republishes its conclusion as a check run the ruleset accepts.
 *
 * ## Two things here look like redundancy and are not
 *
 * **The mirrored check is not a duplicate of the dispatched run's own check.**
 * Both carry the same name on the same commit. Only the mirror satisfies the
 * ruleset: a check derived from a `workflow_dispatch` run does not count toward a
 * required status check, while one created through the Checks API does. Measured
 * with every confounder removed — a human-opened pull request, a fresh commit, no
 * held run, nothing deleted, a successful check on the head commit, still
 * blocked. Delete the mirror and agent pull requests stop merging.
 *
 * **The held `action_required` run must be left alone.** Every agent pull request
 * carries one, it shows as a pending check, and deleting it is the obvious
 * cleanup. Doing so destroys the commit's check rollup permanently: REST goes on
 * reporting the check runs and suites as successful and associated with the pull
 * request while GraphQL reports `statusCheckRollup: null`, and re-running CI does
 * not repair it, because the damage is to the commit rather than to any run.
 * Left in place it is harmless — with the mirror present the pull request reaches
 * `UNSTABLE`, which the ruleset permits.
 *
 * ## Why the waiting happens here rather than in an agent
 *
 * Nothing wakes an agent when CI finishes. A completed run fires `workflow_run`
 * only when the originating event came from something other than `GITHUB_TOKEN`,
 * and neither a bot's `pull_request` (even after approval) nor a
 * `workflow_dispatch` qualifies — the documented `workflow_dispatch` exemption
 * covers creating a run, not its completion. Agents also have no sleep.
 *
 * A workflow job can wait, because a loop inside a live job is not a new trigger.
 * That is the whole reason this sequencing lives in a script the runner calls.
 *
 * ## If GitHub closes this
 *
 * The mechanism is sanctioned — Checks API check runs are how third-party CI
 * reports into a pull request, and `GITHUB_TOKEN` satisfies the app-only
 * restriction because it is an installation token for the github-actions app. The
 * purpose is not: it satisfies a required check for code GitHub held back. The
 * narrowest closure would stop `GITHUB_TOKEN` creating check runs on a commit
 * whose pull request `GITHUB_TOKEN` opened, which would leave third-party CI
 * intact.
 *
 * Two retreats, each giving up something this design keeps:
 *
 * - Drop the required check from the ruleset. Merging then needs only a pull
 *   request, and whether CI passed becomes the reviewer's judgement rather than a
 *   server-side rule — one ruleset no longer governs humans and agents alike.
 * - Give the agent a trusted identity, a GitHub App or a personal access token,
 *   for opening and pushing to the pull request. Nothing is held, so nothing needs
 *   mirroring and no human acts — at the cost of an adoption step, and of
 *   attributing the agent's commits to whoever owns the token.
 *
 * ## The deliverable is checked before CI is asked to run
 *
 * `--deliverable-report` names the file `validate_deliverable.ts` wrote for this
 * pull request. A non-empty one means the pull request would merge a
 * `.github/atoma/` that cannot start a run, and this script then writes the failing
 * checks and hands it back WITHOUT dispatching CI — there is nothing to learn from
 * running a pipeline against a deliverable that cannot be loaded.
 *
 * Usage:
 *   validate_pull_request.ts --repo owner/name --number N --branch atoma/issue-N
 *     --workflow ci.yml --reviewer reviewer --engineer engineer
 *     --deliverable-report FILE [--timeout-seconds 1800]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decideValidationOutcome } from "../domain/pr-validation.ts";
import { gh } from "../lib/gh.ts";
import { readRequiredChecks } from "../lib/branch-rules.ts";
import { CI_RETRY_TAG, LLM_CONTEXT_TAG } from "../lib/tags.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface ValidatePullRequestArgs {
  repo: string;
  number: string;
  branch: string;
  workflow: string;
  reviewer: string;
  engineer: string;
  /**
   * File `validate_deliverable.ts` wrote, one problem per line and empty when
   * there are none.
   *
   * A path that does not exist stops the run rather than standing in for "no
   * problems". The step that writes it always writes it, so an absent file means
   * the step did not run — and a validation that did not happen must not be
   * reported as one that passed. Same reasoning as `required.known` below.
   */
  "deliverable-report": string;
  /** Defaults to 1800. The job's own `timeout-minutes` is deliberately longer,
   *  so a stall is reported as "no conclusion" here rather than killed there
   *  with nothing written. */
  "timeout-seconds"?: string;
}

export const ref = defineScript<ValidatePullRequestArgs>(import.meta.url);

function log(message: string): void {
  console.error(`[atoma-validate-pr] ${message}`);
}

export interface RunRef {
  id: number;
  status: string;
  conclusion: string | null;
}

/**
 * Find the dispatched run.
 *
 * `gh workflow run` returns nothing identifying, so the run has to be recognised
 * afterwards. Matching on head SHA rather than branch is what keeps a human's
 * concurrent push to the same branch from being mistaken for this one: that push
 * produces a different commit.
 *
 * `since` excludes runs that already existed, so a previous validation of the
 * same commit cannot be adopted as this one.
 */
export function pickDispatchedRun(
  runs: { id: number; status: string; conclusion: string | null; head_sha: string; created_at: string; event: string }[],
  headSha: string,
  since: string,
): RunRef | undefined {
  const candidates = runs
    .filter((run) => run.event === "workflow_dispatch")
    .filter((run) => run.head_sha === headSha)
    .filter((run) => run.created_at >= since)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const run = candidates[0];
  return run ? { id: run.id, status: run.status, conclusion: run.conclusion } : undefined;
}

/** Comments this script has left on the pull request, each marking one hand-back. */
function countPriorRetries(repo: string, number: string): number {
  const { code, stdout } = gh("api", `repos/${repo}/issues/${number}/comments?per_page=100`);
  if (code) return 0;
  try {
    const comments = JSON.parse(stdout || "[]") as { body?: string }[];
    return comments.filter((c) => CI_RETRY_TAG.has(c.body ?? "")).length;
  } catch {
    return 0;
  }
}

/**
 * Leave the engineer what it needs to act, and leave the count its next turn
 * reads.
 *
 * The failing job's URL rather than its log: the engineer can fetch what it wants
 * from there, and pasting a log costs tokens on every retry whether or not the
 * relevant lines are in the part that fits.
 */
function reportFailure(
  repo: string,
  number: string,
  attempt: number,
  runUrl: string,
  summary: string,
  details: readonly string[] = [],
): void {
  // `summary` is also a step output, which is one line by construction, so the list
  // of problems travels here rather than being folded into it. The engineer needs
  // all of them at once: one per round trip costs a model run each.
  const body = [
    LLM_CONTEXT_TAG.write("include"),
    CI_RETRY_TAG.write(attempt),
    `Atoma: ${summary}`,
    ...(details.length > 0 ? ["", ...details.map((detail) => `- ${detail}`)] : []),
    "",
    runUrl ? `Failing run: ${runUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const posted = gh("issue", "comment", number, "--repo", repo, "--body", body);
  if (posted.code) log(`WARN could not post the failure comment: ${posted.stderr}`);
}

/**
 * Dispatch CI and wait for it, returning what it concluded.
 *
 * A function rather than the body of `main`, so the one caller that must NOT run it
 * — a pull request whose own `.github/atoma/` is broken — can skip it by not
 * calling it, instead of by an early return that would also skip writing the
 * checks and the comment.
 *
 * An empty `conclusion` means the run timed out, was cancelled, or was never
 * found. That is deliberately not an error here: `decideValidationOutcome` has a
 * verdict for it that dispatches nobody.
 */
function runCiAndWait(
  repo: string,
  workflow: string,
  branch: string,
  headSha: string,
  timeoutSeconds: number,
): { conclusion: string; runUrl: string } {
  const since = new Date().toISOString();
  const dispatch = gh("workflow", "run", workflow, "--repo", repo, "--ref", branch);
  if (dispatch.code) {
    log(`could not dispatch ${workflow} against ${branch}: ${dispatch.stderr}`);
    process.exit(1);
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    Bun.sleepSync(10_000);
    const listed = gh("api", `repos/${repo}/actions/runs?per_page=30&event=workflow_dispatch`).stdout;
    const { workflow_runs = [] } = JSON.parse(listed || "{}") as {
      workflow_runs?: {
        id: number;
        status: string;
        conclusion: string | null;
        head_sha: string;
        created_at: string;
        event: string;
      }[];
    };
    const run = pickDispatchedRun(workflow_runs, headSha, since);
    if (!run) continue;
    if (run.status !== "completed") continue;
    const conclusion = run.conclusion ?? "";
    log(`dispatched run ${run.id} concluded ${conclusion}`);
    return { conclusion, runUrl: `https://github.com/${repo}/actions/runs/${run.id}` };
  }

  log(`no conclusion within ${timeoutSeconds}s`);
  return { conclusion: "", runUrl: "" };
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      number: { type: "string" },
      branch: { type: "string" },
      workflow: { type: "string" },
      reviewer: { type: "string" },
      engineer: { type: "string" },
      "deliverable-report": { type: "string" },
      "timeout-seconds": { type: "string" },
    },
  });

  const repo = values.repo ?? "";
  const branch = values.branch ?? "";
  const workflow = values.workflow ?? "";
  if (!repo || !branch || !workflow) {
    console.error("usage: validate_pull_request.ts --repo owner/name --number N --branch B --workflow W");
    process.exit(1);
  }

  // Read before anything is decided, and an absent file stops the run. The step
  // that writes it writes it unconditionally, including empty, so absence means the
  // step did not run — and "we did not check" must never be able to look like
  // "there was nothing wrong". Same reasoning as `required.known` below.
  const reportPath = values["deliverable-report"] ?? "";
  if (!reportPath) {
    console.error("usage: validate_pull_request.ts ... --deliverable-report FILE");
    process.exit(1);
  }
  if (!existsSync(reportPath)) {
    log(`cannot validate: no deliverable report at ${reportPath}`);
    process.exit(1);
  }
  const deliverableProblems = readFileSync(reportPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (deliverableProblems.length > 0) {
    log(`the deliverable is inconsistent (${deliverableProblems.length} problem(s)); CI will not be dispatched`);
  }

  const githubOutput = process.env.GITHUB_OUTPUT;
  const write = (line: string): void => {
    if (githubOutput) appendFileSync(githubOutput, `${line}\n`);
  };

  const prJson = gh("api", `repos/${repo}/pulls/${values.number}`).stdout;
  const pr = JSON.parse(prJson || "{}") as { head?: { sha?: string }; base?: { ref?: string } };
  const headSha = pr.head?.sha ?? "";
  const baseRef = pr.base?.ref ?? "";
  if (!headSha) {
    log("could not read the pull request's head SHA");
    process.exit(1);
  }

  // An unknown answer stops the run rather than standing in for "nothing is
  // required". This is the caller that cannot treat the two alike: it mirrors one
  // check run per required context, and `passed` below is `every()` over that
  // list, which is `true` for an empty one. So a failed read would report a
  // FAILING run as passed, suppress the failure comment, and — because that
  // comment is also the retry tally — leave the retry limit that bounds the
  // engineer/CI loop unable to ever fire.
  const required = readRequiredChecks(repo, baseRef);
  if (!required.known) {
    log(`cannot validate: ${required.why}`);
    process.exit(1);
  }
  const requiredContexts = required.contexts;
  log(`required contexts on ${baseRef}: ${requiredContexts.join(", ") || "(none)"}`);
  if (requiredContexts.length === 0) {
    // Legitimate, and worth saying once: with nothing required, this writes no
    // check runs and every run reports as passed. That is accurate — no required
    // check failed — but it means CI results gate nothing, which is usually a
    // ruleset that was never imported rather than a decision.
    log(
      `::warning::${baseRef} requires no status checks, so CI results gate nothing here. ` +
        "Import .github/atoma/rulesets/main.json if that was not intended.",
    );
  }

  // Not dispatched at all when the deliverable itself is inconsistent. CI would
  // either fail for an unrelated-looking reason or pass and say nothing, and the
  // verdict is decided either way: `decideValidationOutcome` reads the problems
  // first and never looks at a conclusion.
  const { conclusion, runUrl } =
    deliverableProblems.length > 0
      ? { conclusion: "", runUrl: "" }
      : runCiAndWait(repo, workflow, branch, headSha, Number(values["timeout-seconds"] ?? "1800"));

  // How many times validation already sent this pull request back. Counted from
  // its own comments rather than held anywhere, so it survives a re-dispatch and
  // needs no state of its own.
  const priorRetries = countPriorRetries(repo, values.number ?? "");

  const outcome = decideValidationOutcome({
    conclusion,
    requiredContexts,
    reviewerAgent: values.reviewer ?? "",
    engineerAgent: values.engineer ?? "",
    priorRetries,
    deliverableProblems,
  });

  for (const check of outcome.checks) {
    // The Checks API, not a workflow's own check. See the header: only this form
    // satisfies a required status check for an agent's pull request.
    const created = gh(
      "api",
      "--method",
      "POST",
      `repos/${repo}/check-runs`,
      "-f",
      `name=${check.name}`,
      "-f",
      `head_sha=${headSha}`,
      "-f",
      "status=completed",
      "-f",
      `conclusion=${check.conclusion}`,
    );
    if (created.code) log(`WARN could not write check "${check.name}": ${created.stderr}`);
    else log(`wrote check "${check.name}" as ${check.conclusion}`);
  }

  // Posted whenever CI did not pass, including the turn that gives up: the
  // comment is both the engineer's brief and the tally the next turn counts, and
  // the last one is what tells a human why nothing is moving.
  //
  // Read from the verdict, not re-derived from `checks`. It used to be
  // `checks.every((c) => c.conclusion === "success")`, which is `true` for the
  // empty list a base branch with no required checks produces -- so a failing
  // run posted no comment, the engineer was dispatched with no brief, and the
  // tally that bounds that loop never advanced. See `ValidationOutcome.verdict`.
  if (outcome.verdict !== "passed") {
    reportFailure(repo, values.number ?? "", priorRetries + 1, runUrl, outcome.summary, deliverableProblems);
  }

  write(`next_agent=${outcome.nextAgent}`);
  write(`conclusion=${conclusion}`);
  write(`summary=${outcome.summary}`);
}

if (import.meta.main) main();

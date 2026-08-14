#!/usr/bin/env bun
/**
 * github.ts — Unified GitHub MCP server for Atoma.
 *
 * Transport: stdio, via the official @modelcontextprotocol/sdk.
 * Dependencies: `gh` CLI + `git`.
 *
 * Every mutation is logged to $ATOMA_OPS_LOG (see lib/ops-log.ts) as a
 * general audit trail; dispatch decisions specifically are also what
 * atoma-runner.wac.ts's chain_continues detection reads.
 *
 * IMPORTANT: this process's `process.stdout` IS the JSON-RPC transport --
 * never `console.log()` anywhere in this file or in anything it calls
 * in-process (resolveNotify/dispatchOrchestratorIfSubIssueReady/etc.);
 * always `console.error()` (`log()` below) for logging.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { dispatchWorkflow, gh, ghGraphql, gitRun } from "../../../../lib/gh.ts";
import { getLabel, getMergePolicy, getTriggerAgent, getWorkflowName } from "../../../../lib/config.ts";
import { resolveNotify } from "../../../../lib/notify.ts";
import { dispatchOrchestratorIfSubIssueReady } from "../../../../lib/aggregation.ts";
import { dispatchRunner } from "../../../../lib/dispatch.ts";
import { logOp } from "../../../../lib/ops-log.ts";
import { LLM_CONTEXT_TAG, NOTIFY_TAG, ORIGIN_AGENT_TAG, PARENT_ISSUE_TAG, PARENT_TAG } from "../../../../lib/tags.ts";
import type { GhIssueAuthor } from "../../../../lib/types.ts";
import { buildMcpTools, defineMcpTool, positiveInt, stringArray, z, type McpToolResult } from "../../../../lib/mcp-tool.ts";
import { decidePostMergeHandoff } from "../../../../domain/handoff.ts";
import { decideMergeReadiness, formatBlockers } from "../../../../domain/merge-readiness.ts";
import { gatherMergeSignals } from "../../../../lib/merge-signals.ts";

function log(msg: string): void {
  console.error(`[atoma-github] ${msg}`);
}

let REPO = process.env.GITHUB_REPOSITORY ?? "";
// Fallback: derive REPO from git remote if env var is not set.
if (!REPO) {
  try {
    const { code, stdout } = gitRun("remote", "get-url", "origin");
    if (code === 0 && stdout) {
      const url = stdout.trim();
      for (const prefix of ["https://github.com/", "git@github.com:"]) {
        if (url.startsWith(prefix)) {
          const suffix = url.slice(prefix.length);
          REPO = suffix.endsWith(".git") ? suffix.slice(0, -4) : suffix;
          break;
        }
      }
    }
  } catch {
    // best-effort
  }
}

function mcpFail(message: string): never {
  throw new Error(message);
}

function ghJsonOrThrow<T>(...args: string[]): T {
  const { code, stdout, stderr } = gh(...args);
  if (code) mcpFail(stderr || stdout);
  return stdout ? (JSON.parse(stdout) as T) : (null as T);
}

async function resolveIssueId(number: number): Promise<string> {
  const [owner, repo] = REPO.split("/", 2);
  const d = ghGraphql<{ repository: { issue: { id: string } } }>(
    "query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){id}}}",
    { owner: owner!, repo: repo!, num: number },
  );
  return d.repository.issue.id;
}

/**
 * Shared schema for tools that take a single required `number` (issue/PR
 * number) argument.
 *
 * `number` stays required for every mutation, and for every PR read. Only the
 * two issue reads below default it — see `ISSUE_CONTEXT_NUMBER_ARG_SCHEMA`.
 */
const NUMBER_ARG_SCHEMA = z.object({
  number: positiveInt("Positive GitHub issue or pull request number, without a leading '#'."),
});

/**
 * Schema for the two read-only ISSUE lookups, whose `number` defaults to the
 * issue this run is already operating on.
 *
 * Deliberately not used for PR reads or for any mutation:
 *
 * - Mutations (`close_issue`, `merge_pr`): inferring the target of an
 *   irreversible, outward-facing action from an environment variable turns a
 *   malformed call into a wrong merge instead of an error message.
 * - PR reads (`get_pr`, `get_pr_diff`, ...): `ISSUE_NUMBER` carries whichever
 *   number the run resolved, and the run env does not say whether that was an
 *   issue or a PR. Defaulting a PR read during an issue-context run would shell
 *   out `gh pr view <issue-number>`, replacing a precise "number: Required"
 *   with a confusing GitHub error. Observed production failures were all on the
 *   two issue reads, so the fallback stops there.
 */
const ISSUE_CONTEXT_NUMBER_ARG_SCHEMA = z.object({
  number: positiveInt(
    "Positive GitHub issue number, without a leading '#'. " +
      "Omit to use the issue this run is already operating on.",
  ).optional(),
});

/**
 * Resolve an issue read's target, falling back to the run's issue number.
 *
 * Models omit `number` entirely when they are already reasoning about a single
 * issue, which used to surface as `number: Required` and burn an iteration.
 * `ISSUE_NUMBER` is the number the runner resolved for this run (see
 * `atoma-runner.wac.ts`), and is already relied on elsewhere in this file.
 */
function issueContextNumber(args: { number?: number }): number {
  if (args.number !== undefined) return args.number;
  const raw = (process.env.ISSUE_NUMBER ?? "").trim();
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed <= 0) {
    mcpFail("`number` was omitted and this run has no current issue number. Pass `number` explicitly.");
  }
  return parsed;
}

const CREATE_ISSUE_SCHEMA = z.object({
  title: z.string().min(1).describe("Concise issue title."),
  body: z.string().optional().describe("Issue body in GitHub-flavored Markdown. Defaults to an empty body."),
  labels: stringArray("Existing repository label names to apply. Defaults to no extra labels.").optional(),
  sub_issue: z
    .boolean()
    .optional()
    .describe("Set sub_issue=true to automatically link it to the current issue as a child task. Defaults to true."),
});

const LIST_ISSUES_SCHEMA = z.object({
  state: z.enum(["open", "closed", "all"]).optional().describe("Issue state filter. Defaults to 'open'."),
  labels: stringArray("Return only issues matching these repository labels.").optional(),
  limit: positiveInt("Maximum issues to return. Defaults to 30; maximum 100.").max(100).optional(),
});

const CREATE_PR_SCHEMA = z.object({
  title: z.string().min(1).describe("Concise pull request title."),
  body: z.string().optional().describe("Pull request body in GitHub-flavored Markdown. Atoma adds issue traceability metadata automatically."),
  base: z.string().optional().describe("Target branch name. Omit to use the repository default branch."),
});

const LIST_PRS_SCHEMA = z.object({
  state: z.enum(["open", "closed", "merged", "all"]).optional().describe("Pull request state filter. Defaults to 'open'."),
  limit: positiveInt("Maximum pull requests to return. Defaults to 30; maximum 100.").max(100).optional(),
});

const SEARCH_CODE_SCHEMA = z.object({
  query: z.string().min(1).describe("GitHub code-search query scoped automatically to the current repository."),
});
const GET_BRANCH_SCHEMA = z.object({
  name: z.string().min(1).describe("Repository branch name, for example 'main' or 'atoma/issue-42'."),
});
const GET_CHECK_RUNS_SCHEMA = z.object({
  ref: z.string().min(1).describe("Commit SHA, branch name, or tag whose GitHub check runs should be returned."),
});
const SYNC_BRANCH_SCHEMA = z.object({
  branch: z.string().optional().describe("Branch to synchronize. Defaults to the current Atoma branch."),
});

const SUBMIT_PR_REVIEW_SCHEMA = z.object({
  number: positiveInt("Positive pull request number, without a leading '#'."),
  // APPROVE is accepted and silently downgraded to COMMENT (see submitPrReview).
  // It is NOT in the description below, so the model is never told to use it --
  // this is the runtime being forgiving about a shape it is not advertising, the
  // same bargain positiveInt/stringArray strike in lib/mcp-tool.ts.
  event: z
    .enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"])
    .describe("Review outcome. Use COMMENT for approval-like feedback because GitHub forbids bot self-approval."),
  body: z.string().optional().describe("Review summary in GitHub-flavored Markdown. Required in practice for REQUEST_CHANGES."),
});

const COMMIT_AND_PUSH_SCHEMA = z.object({
  message: z.string().describe("Commit message."),
});


function notifyTagPrefix(): string {
  const login = (process.env.ISSUE_NOTIFY ?? "").trim();
  return login ? `${NOTIFY_TAG.write(login)}\n` : "";
}

async function createIssue(a: z.infer<typeof CREATE_ISSUE_SCHEMA>): Promise<string> {
  const title = a.title;
  let body = a.body ?? "";
  let labels = a.labels ?? [];
  const sub = a.sub_issue ?? true;
  const parentNum = (process.env.ISSUE_NUMBER ?? "").trim();

  body = notifyTagPrefix() + body;
  if (sub) {
    if (parentNum) body = `${PARENT_TAG.write(Number(parentNum))}\n${body}`;
    const subIssueLabel = getLabel("sub_issue", "atoma/sub-issue");
    const ensured = gh(
      "label", "create", subIssueLabel,
      "--repo", REPO,
      "--force",
      "--color", "8250df",
      "--description", "Child delivery task managed by Atoma",
    );
    if (ensured.code) mcpFail(`Failed to ensure sub-issue label '${subIssueLabel}': ${ensured.stderr || ensured.stdout}`);
    if (!labels.includes(subIssueLabel)) labels = [...labels, subIssueLabel];
  }

  const cmd = ["issue", "create", "--repo", REPO, "--title", title];
  if (body) cmd.push("--body", body);
  for (const l of labels) cmd.push("--label", l);

  const { code, stdout, stderr } = gh(...cmd);
  if (code) mcpFail(stderr || stdout);
  const num = Number(stdout.trim().split("/").pop());
  if (!Number.isFinite(num)) mcpFail(`gh issue create: unexpected output: ${stdout.slice(0, 300)}`);

  if (sub && parentNum) {
    try {
      const pid = await resolveIssueId(Number(parentNum));
      const sid = await resolveIssueId(num);
      ghGraphql(
        "mutation($parent:ID!,$sub:ID!){addSubIssue(input:{issueId:$parent,subIssueId:$sub,replaceParent:true}){issue{number}}}",
        { parent: pid, sub: sid },
      );
      log(`Linked sub-issue #${num} to parent #${parentNum} via official sub-issues API`);
    } catch (e) {
      log(`WARN: Failed to link sub-issue #${num} to parent #${parentNum}: ${e}`);
    }
  }

  logOp("create_issue", { number: num, title, sub_issue: sub });
  return JSON.stringify({ number: num, url: stdout.trim() });
}

function getIssue(a: z.infer<typeof ISSUE_CONTEXT_NUMBER_ARG_SCHEMA>): string {
  return JSON.stringify(ghJsonOrThrow("issue", "view", String(issueContextNumber(a)), "--repo", REPO, "--json", "number,title,body,state,labels,createdAt,closedAt,comments"));
}

function listIssues(a: z.infer<typeof LIST_ISSUES_SCHEMA>): string {
  const state = a.state ?? "open";
  const limit = a.limit ?? 30;
  const labels = a.labels ?? [];
  const cmd = ["issue", "list", "--repo", REPO, "--state", state, "--limit", String(limit), "--json", "number,title,state,labels"];
  for (const l of labels) cmd.push("--label", l);
  return JSON.stringify(ghJsonOrThrow(...cmd) ?? []);
}

function getIssueComments(a: z.infer<typeof ISSUE_CONTEXT_NUMBER_ARG_SCHEMA>): string {
  const d = ghJsonOrThrow<{ comments?: unknown[] }>("issue", "view", String(issueContextNumber(a)), "--repo", REPO, "--json", "comments");
  return JSON.stringify(d?.comments ?? []);
}

function closeIssue(a: z.infer<typeof NUMBER_ARG_SCHEMA>): string {
  const num = a.number;
  log(`closeIssue: #${num}`);
  // Refuse to close issues opened by humans.
  // NOTE: `gh issue view --json author` returns {id, is_bot, login, name} --
  // there is NO `.type` field (that only exists on the REST
  // `gh api repos/OWNER/REPO/issues/N` endpoint, as `.user.type`). Use the
  // reliable `.author.is_bot` boolean instead.
  const d = ghJsonOrThrow<GhIssueAuthor>("issue", "view", String(num), "--repo", REPO, "--json", "author");
  const isBot = Boolean(d?.author?.is_bot);
  log(`closeIssue: author.is_bot=${isBot}`);
  if (!isBot) mcpFail(`Refusing to close issue #${num}: opened by a human, not a bot`);
  const { code, stdout, stderr } = gh("issue", "close", String(num), "--repo", REPO);
  if (code) mcpFail(stderr || stdout);
  logOp("close_issue", { number: num });
  return JSON.stringify({ ok: true });
}

/**
 * Runs closeIssue()'s own logic, then -- whether this is a sub-issue closed
 * via the normal merge_pr path or via an origin-agent re-invocation
 * confirming its own work -- checks phase-gating/aggregation for its
 * parent, so it fires regardless of which path closed the issue.
 * dispatchOrchestratorIfSubIssueReady no-ops harmlessly if #num has no
 * atoma:parent tag. Awaited by every caller (matching the original
 * Bun.spawnSync-based blocking behavior) so the tool response isn't
 * returned before phase-gating has actually run.
 */
async function closeIssueAndDispatch(a: z.infer<typeof NUMBER_ARG_SCHEMA>): Promise<string> {
  const result = closeIssue(a);
  const num = a.number;
  try {
    await dispatchOrchestratorIfSubIssueReady(REPO, num);
  } catch (e) {
    log(`closeIssueAndDispatch: dispatchOrchestratorIfSubIssueReady failed for #${num}: ${e}`);
  }
  return result;
}

function resolveBranch(): string {
  const br = (process.env.BRANCH ?? "").trim();
  if (br && br !== "HEAD") return br;
  {
    const { code, stdout } = gitRun("rev-parse", "--abbrev-ref", "HEAD");
    if (code === 0 && stdout && stdout !== "HEAD") return stdout;
  }
  {
    const { code, stdout } = gitRun("branch", "--format=%(refname:short)", "--points-at=HEAD");
    if (code === 0 && stdout) return stdout.split("\n")[0]!;
  }
  mcpFail("Cannot determine branch name; set BRANCH env");
}

function injectParentIssue(body: string): string {
  const parent = (process.env.ISSUE_NUMBER ?? "").trim();
  if (NOTIFY_TAG.has(body)) mcpFail("PR body already contains a notify tag; refusing to add another");
  body = notifyTagPrefix() + body;
  if (!parent) return body;
  if (PARENT_ISSUE_TAG.has(body)) {
    mcpFail("PR body already contains a parent-issue tag; refusing to add another");
  }
  // Inject parent-issue metadata always, but only add "Closes #N" if the body
  // doesn't already reference it -- agents sometimes write their own closing
  // keyword, and a duplicate "Closes #N" line makes downstream parsing match
  // twice, corrupting $GITHUB_OUTPUT.
  let closesLine = "";
  if (!new RegExp(`\\bcloses\\s+#${parent}\\b`, "i").test(body)) {
    closesLine = `Closes #${parent}\n`;
  }
  const originAgent = (process.env.AGENT ?? "").trim();
  const originLine = originAgent ? `${ORIGIN_AGENT_TAG.write(originAgent)}\n` : "";
  return `${PARENT_ISSUE_TAG.write(Number(parent))}\n${originLine}${closesLine}${body}`;
}

/**
 * Hand the new pull request to validation rather than straight to a reviewer.
 *
 * The reviewer used to be dispatched from here, and arrived before CI had a
 * verdict -- so it either reported that it would wait, with nothing able to wake
 * it, or merged without one. Validation runs CI first and dispatches the agent
 * the result calls for: the reviewer when it passes, the engineer when it does
 * not. See `scripts/validate_pull_request.ts`.
 *
 * Dispatch rather than an event, because GitHub starts no workflow run for
 * events GITHUB_TOKEN triggers and this pull request was created with it.
 * `workflow_dispatch` is the documented exception, which is also why
 * atoma-auto-trigger.yml cannot be relied on here.
 *
 * Best-effort: a dispatch failure does not fail PR creation itself.
 */
function dispatchPrValidation(prNumber: number, branch: string): void {
  const reviewer = getTriggerAgent("pull_request.opened", "reviewer");
  dispatchWorkflow(
    `dispatchPrValidation: validating PR #${prNumber}`,
    "atoma-validate-pr.yml",
    [
      "--repo", REPO,
      "-f", `number=${prNumber}`,
      "-f", `branch=${branch}`,
      "-f", `reviewer=${reviewer}`,
      "-f", "engineer=engineer",
    ],
    log,
  );
}

function createPr(a: z.infer<typeof CREATE_PR_SCHEMA>): McpToolResult {
  const title = a.title;
  let body = a.body ?? "";
  const base = a.base;
  body = injectParentIssue(body);
  log(`createPr: title=${JSON.stringify(title)}, base=${JSON.stringify(base)}, REPO=${JSON.stringify(REPO)}`);

  const branch = resolveBranch();
  log(`createPr: resolved branch=${JSON.stringify(branch)}`);

  const worktree = gitRun("status", "--porcelain");
  if (worktree.code) mcpFail(worktree.stderr || worktree.stdout);
  if (worktree.stdout.trim()) {
    mcpFail("Cannot create a PR with uncommitted changes. Call github__commit_and_push first.");
  }
  const head = gitRun("rev-parse", "HEAD");
  if (head.code) mcpFail(`Cannot resolve local HEAD: ${head.stderr || head.stdout}`);
  const remote = gitRun("ls-remote", "--heads", "origin", `refs/heads/${branch}`);
  if (remote.code) mcpFail(`Cannot inspect remote branch '${branch}': ${remote.stderr || remote.stdout}`);
  const remoteHead = remote.stdout.trim().split(/\s+/, 1)[0] ?? "";
  if (!remoteHead) {
    mcpFail(`Remote branch '${branch}' does not exist. Call github__commit_and_push before creating the PR.`);
  }
  if (remoteHead !== head.stdout.trim()) {
    mcpFail(
      `Remote branch '${branch}' is not at local HEAD. Call github__sync_branch and inspect its status; ` +
      `if it reports 'ahead', call github__commit_and_push before creating the PR.`,
    );
  }

  const cmd = ["pr", "create", "--repo", REPO, "--title", title, "--head", branch];
  if (body) cmd.push("--body", body);
  if (base) cmd.push("--base", base);
  log(`createPr: running gh ${cmd.join(" ")}`);
  const { code, stdout, stderr } = gh(...cmd);
  log(`createPr: gh pr create rc=${code}, out=${JSON.stringify(stdout)}, err=${JSON.stringify(stderr)}`);
  if (code) mcpFail(`gh pr create failed (rc=${code}): ${stderr || stdout}`);

  const num = Number(stdout.trim().split("/").pop());
  if (!Number.isFinite(num)) mcpFail(`gh pr create: unexpected output: ${stdout.slice(0, 300)}`);

  logOp("create_pr", { number: num, title });
  dispatchPrValidation(num, branch);

  // Traceability: the reviewer dispatch above is fire-and-forget, and (since
  // this call now ends the session immediately, see the returned
  // meta.session_ends below) no further agent text will be posted on the
  // CURRENT issue about this -- record it here explicitly, the same way
  // dispatchSubAgent always confirms its own dispatch with a comment.
  const currentIssue = (process.env.ISSUE_NUMBER ?? "").trim();
  if (currentIssue) {
    gh(
      "issue", "comment", currentIssue, "--repo", REPO,
      "--body", `${LLM_CONTEXT_TAG.write("exclude")}\nAtoma: PR #${num} created (${stdout.trim()}). Running CI; the reviewer follows if it passes.`,
    );
  }

  // From the calling agent's (engineer's) perspective, create_pr should
  // behave like launch_sub_agent: a normal-looking synchronous tool call
  // that, once it returns, immediately ends this session. The agent is
  // re-invoked later (see dispatchPostMergeAgent) once the PR actually
  // concludes (merged, or sent back via changes_requested), at which point
  // that re-invocation is framed as the deferred continuation of this exact
  // call -- not a brand-new unrelated task. This keeps the engineer's own
  // run from continuing to execute concurrently with the reviewer run just
  // dispatched above (the whole point of the "serial" design).
  return { text: JSON.stringify({ number: num, url: stdout.trim() }), meta: { session_ends: true } };
}

function commitAndPush(a: z.infer<typeof COMMIT_AND_PUSH_SCHEMA>): string {
  const message = a.message;
  {
    const { code, stdout, stderr } = gitRun("add", "-A");
    if (code) mcpFail(stderr || stdout);
  }
  {
    const { code, stdout, stderr } = gitRun("commit", "-m", message);
    if (code) mcpFail(stderr || stdout);
  }
  const branch = resolveBranch();
  {
    const { code, stdout, stderr } = gitRun("push", "-u", "origin", branch);
    if (code) mcpFail(stderr || stdout);
  }
  logOp("commit_and_push", {});

  // A push to a branch that already has a pull request has to be validated the
  // same way the first push was. Nothing else will do it: GitHub raises no event
  // for a push made with GITHUB_TOKEN, so neither CI nor any routing workflow
  // hears about this commit, and the pull request would keep whatever check the
  // previous head commit had -- on a commit that is no longer the head, so the
  // ruleset sees the required context as missing and the merge stays refused.
  //
  // Skipped when there is no pull request yet, which is the ordinary first push:
  // `create_pr` dispatches validation itself once the pull request exists, and
  // validating a branch with nothing to merge into would only burn a CI run.
  //
  // Repeated pushes within one run each dispatch, and the validation workflow's
  // own concurrency group collapses them, keeping the last.
  const open = gh("pr", "list", "--repo", REPO, "--head", branch, "--state", "open", "--json", "number");
  if (!open.code) {
    try {
      const [pr] = JSON.parse(open.stdout || "[]") as { number: number }[];
      if (pr) dispatchPrValidation(pr.number, branch);
    } catch {
      log("commitAndPush: could not read the open pull request list; skipping validation dispatch");
    }
  }

  return JSON.stringify({ ok: true });
}

function syncBranch(a: z.infer<typeof SYNC_BRANCH_SCHEMA>): string {
  const branch = a.branch?.trim() || resolveBranch();
  const valid = gitRun("check-ref-format", "--branch", branch);
  if (valid.code) mcpFail(`Invalid branch name '${branch}': ${valid.stderr || valid.stdout}`);
  const current = gitRun("branch", "--show-current");
  if (current.code) mcpFail(current.stderr || current.stdout);
  if (current.stdout.trim() !== branch) {
    mcpFail(`Cannot synchronize '${branch}' while '${current.stdout.trim() || "detached HEAD"}' is checked out.`);
  }

  const worktree = gitRun("status", "--porcelain");
  if (worktree.code) mcpFail(worktree.stderr || worktree.stdout);
  if (worktree.stdout.trim()) {
    mcpFail("Cannot synchronize a branch with uncommitted changes. Commit or discard them first.");
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  const fetch = gitRun("fetch", "origin", `refs/heads/${branch}:${remoteRef}`);
  if (fetch.code) {
    if (/couldn't find remote ref|not our ref/i.test(fetch.stderr)) {
      return JSON.stringify({ branch, status: "remote_missing", ahead: 0, behind: 0 });
    }
    mcpFail(`Failed to fetch remote branch '${branch}': ${fetch.stderr || fetch.stdout}`);
  }

  const counts = gitRun("rev-list", "--left-right", "--count", `HEAD...${remoteRef}`);
  if (counts.code) mcpFail(`Failed to compare branch '${branch}': ${counts.stderr || counts.stdout}`);
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    mcpFail(`Unexpected rev-list output for branch '${branch}': ${counts.stdout}`);
  }

  if (ahead === 0 && behind! > 0) {
    const fastForward = gitRun("merge", "--ff-only", remoteRef);
    if (fastForward.code) mcpFail(`Failed to fast-forward branch '${branch}': ${fastForward.stderr || fastForward.stdout}`);
    logOp("sync_branch", { branch, status: "fast_forwarded", ahead, behind });
    return JSON.stringify({ branch, status: "fast_forwarded", ahead, behind });
  }

  const status = ahead! > 0 && behind! > 0 ? "diverged" : ahead! > 0 ? "ahead" : "up_to_date";
  logOp("sync_branch", { branch, status, ahead, behind });
  return JSON.stringify({ branch, status, ahead, behind });
}

function getPr(a: z.infer<typeof NUMBER_ARG_SCHEMA>): string {
  return JSON.stringify(ghJsonOrThrow("pr", "view", String(a.number), "--repo", REPO, "--json", "number,title,body,state,baseRefName,headRefName,createdAt"));
}

function getPrDiff(a: z.infer<typeof NUMBER_ARG_SCHEMA>): string {
  const { code, stdout, stderr } = gh("pr", "diff", String(a.number), "--repo", REPO);
  if (code) mcpFail(stderr || stdout);
  return stdout.slice(0, 50000);
}

function listPrs(a: z.infer<typeof LIST_PRS_SCHEMA>): string {
  const state = a.state ?? "open";
  const limit = a.limit ?? 30;
  return JSON.stringify(ghJsonOrThrow("pr", "list", "--repo", REPO, "--state", state, "--limit", String(limit), "--json", "number,title,state,headRefName,baseRefName") ?? []);
}

function searchCode(a: z.infer<typeof SEARCH_CODE_SCHEMA>): string {
  const { code, stdout, stderr } = gh("search", "code", a.query, "--repo", REPO, "--limit", "30");
  if (code) mcpFail(stderr || stdout);
  return stdout.slice(0, 50000);
}

function getBranch(a: z.infer<typeof GET_BRANCH_SCHEMA>): string {
  return JSON.stringify(ghJsonOrThrow("api", `repos/${REPO}/branches/${a.name}`));
}

function getCheckRuns(a: z.infer<typeof GET_CHECK_RUNS_SCHEMA>): string {
  const d = ghJsonOrThrow<{ check_runs?: unknown[] }>("api", `repos/${REPO}/commits/${a.ref}/check-runs`);
  return JSON.stringify(d?.check_runs ?? []);
}

function getPrReviews(a: z.infer<typeof NUMBER_ARG_SCHEMA>): string {
  const d = ghJsonOrThrow<{ reviews?: unknown[] }>("pr", "view", String(a.number), "--repo", REPO, "--json", "reviews");
  return JSON.stringify(d?.reviews ?? []);
}

function listPrReviewComments(a: z.infer<typeof NUMBER_ARG_SCHEMA>): string {
  return JSON.stringify(ghJsonOrThrow(`api`, `repos/${REPO}/pulls/${a.number}/comments`) ?? []);
}

function submitPrReview(a: z.infer<typeof SUBMIT_PR_REVIEW_SCHEMA>): string {
  let event: string = a.event;
  if (event === "APPROVE") {
    // GitHub always rejects self-approval since all Atoma agents share the
    // same bot identity ("Can not approve your own pull request"). Rewrite
    // to COMMENT instead of letting the gh call fail.
    //
    // Reviewers do reach for APPROVE despite the description saying not to --
    // it is the obvious word for what they mean. Rewriting costs nothing and
    // preserves their intent; rejecting the call would spend an iteration
    // teaching them a rule that changes nothing about the outcome.
    log(`submitPrReview: rewriting event APPROVE -> COMMENT for PR #${a.number} (self-approval is never possible)`);
    event = "COMMENT";
  }
  const cmd = ["pr", "review", String(a.number), "--repo", REPO, "--" + event.toLowerCase()];
  if (a.body) cmd.push("--body", a.body);
  const { code, stdout, stderr } = gh(...cmd);
  if (code) mcpFail(stderr || stdout);
  logOp("submit_pr_review", { number: a.number, event });
  return JSON.stringify({ ok: true });
}

/** True if `number` is currently closed (used to skip a pointless post-merge re-invocation when native "Closes #N" auto-close already did the job). */
function isIssueClosed(number: number): boolean {
  const d = ghJsonOrThrow<{ state?: string }>("issue", "view", String(number), "--repo", REPO, "--json", "state");
  return (d?.state ?? "").toUpperCase() === "CLOSED";
}

/**
 * After a PR merges, re-invoke the agent that originally created it (tagged
 * via <!-- atoma:origin-agent=... --> in the PR body, see injectParentIssue)
 * on the linked sub-issue, instead of silently closing the sub-issue
 * ourselves. Returns true if the dispatch was sent (best-effort; a failure
 * here should not fail merge_pr itself -- caller falls back to closing
 * directly).
 */
function dispatchPostMergeAgent(subIssueNum: number, agent: string): boolean {
  const notify = resolveNotify(REPO, subIssueNum);
  {
    const { code, stdout, stderr } = gh(
      "issue", "comment", String(subIssueNum), "--repo", REPO,
      "--body", "Atoma: Your PR was merged. Please confirm completion and close this sub-task.",
    );
    if (code) {
      log(`dispatchPostMergeAgent: could not post trigger comment on #${subIssueNum}: ${stderr || stdout}`);
      return false;
    }
  }
  return dispatchRunner({
    context: `dispatchPostMergeAgent: re-invoking ${agent} on #${subIssueNum} to confirm and close`,
    agent,
    type: "issue",
    number: subIssueNum,
    notify,
    repo: REPO,
    log,
  });
}


/** Kick off the CI workflow against a branch, so a fresh agent PR gets a check run. */
function dispatchCi(branch: string): boolean {
  const workflow = getWorkflowName("ci", "ci.yml");
  return dispatchWorkflow("dispatchCi", workflow, ["--ref", branch], log);
}

/**
 * Kick off the deployment workflow after a merge.
 *
 * Required, not a nicety. This merge is performed with GITHUB_TOKEN, and GitHub
 * starts no workflow run for events its own token triggers — so merging fires no
 * `push` on the base branch, nothing chains off it, and a deployment workflow
 * waiting on that chain never runs. `workflow_dispatch` is the documented
 * exception. Set `workflows.cd` in config.json to the project's deployment
 * workflow, or leave it unset to skip this entirely.
 */
function dispatchCd(baseRef: string): boolean {
  const workflow = getWorkflowName("cd");
  if (!workflow) return false;
  return dispatchWorkflow("dispatchCd", workflow, ["--ref", baseRef || "main"], log);
}

function checkMergeReadiness(a: z.infer<typeof ISSUE_CONTEXT_NUMBER_ARG_SCHEMA>): string {
  const num = issueContextNumber(a);
  const { signals, refs } = gatherMergeSignals(REPO, num, mcpFail);
  const headRefName = refs.headRefName;
  const readiness = decideMergeReadiness(signals);

  const dispatched = readiness.needsCiDispatch && headRefName ? dispatchCi(headRefName) : false;

  return JSON.stringify({
    number: num,
    ready: readiness.ready,
    blockers: readiness.blockers,
    // The branch protection this verdict came from, so a refusal is auditable
    // rather than an assertion: `merge_state_status` is GitHub's own evaluation
    // and `required_checks` is what the ruleset currently demands.
    merge_state_status: signals.mergeStateStatus,
    required_checks: signals.requiredChecks,
    checks: signals.checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
    ci_dispatched: dispatched,
    summary: readiness.ready
      ? "Ready to merge."
      : `Not mergeable:\n${formatBlockers(readiness.blockers)}` +
        (dispatched ? "\n\nCI has been dispatched for the head commit; re-check shortly." : ""),
  });
}

async function mergePr(a: z.infer<typeof NUMBER_ARG_SCHEMA>): Promise<string> {
  const num = a.number;

  // The gate, applied on the path every agent merge takes. The verdict itself is
  // the repository's own branch protection, re-read here rather than restated —
  // see domain/merge-readiness.ts. It is applied at this call site because an
  // agent merge is made with GITHUB_TOKEN, which the ruleset must exempt in order
  // to let the deployment job publish, so protection alone would not stop it.
  const { signals, refs } = gatherMergeSignals(REPO, num, mcpFail);
  const { headRefName, baseRefName } = refs;
  const readiness = decideMergeReadiness(signals);
  if (!readiness.ready) {
    log(`mergePr: refusing PR #${num} — ${readiness.blockers.map((b) => b.kind).join(", ")}`);
    const dispatched = readiness.needsCiDispatch && headRefName ? dispatchCi(headRefName) : false;
    return JSON.stringify({
      merged: false,
      blockers: readiness.blockers,
      ci_dispatched: dispatched,
      reason: `Not mergeable:\n${formatBlockers(readiness.blockers)}`,
    });
  }

  const { code, stdout, stderr } = gh("pr", "merge", String(num), "--repo", REPO, "--squash");
  log(`mergePr: gh pr merge rc=${code}, out=${JSON.stringify(stdout)}, err=${JSON.stringify(stderr)}`);
  if (code) mcpFail(`gh pr merge failed (rc=${code}): ${stderr || stdout}`);
  logOp("merge_pr", { number: num });

  // Nothing else will: this merge produced no `push` event, because GitHub starts
  // no workflow run for events GITHUB_TOKEN triggers.
  dispatchCd(baseRefName);

  const d = ghJsonOrThrow<{ body?: string }>("pr", "view", String(num), "--repo", REPO, "--json", "body");
  const body = d?.body ?? "";
  const parentIssue = PARENT_ISSUE_TAG.read(body);

  const handoff = decidePostMergeHandoff({
    parentIssue,
    parentAlreadyClosed: parentIssue !== undefined && isIssueClosed(parentIssue),
    originAgent: ORIGIN_AGENT_TAG.read(body),
  });

  switch (handoff.kind) {
    case "no-parent":
      return JSON.stringify({ merged: true, closed_issue: null });
    case "already-closed":
      log(`mergePr: parent issue #${handoff.parentIssue} already closed -- skipping post-merge re-invocation`);
      return JSON.stringify({ merged: true, closed_issue: null });
    case "reinvoke-origin-agent":
      if (dispatchPostMergeAgent(handoff.parentIssue, handoff.agent)) {
        return JSON.stringify({ merged: true, closed_issue: null, reinvoked_agent: handoff.agent });
      }
      // The preferred handoff (re-invoking the origin agent) failed to
      // dispatch -- fall back to closing the parent directly ourselves,
      // same as the "close-directly" case below.
      return await closeParentAndReport(handoff.parentIssue);
    case "close-directly":
      return await closeParentAndReport(handoff.parentIssue);
  }
}

/** closeIssueAndDispatch also triggers phase-gating/aggregation itself. Shared by mergePr()'s "close-directly" case and its "reinvoke failed" fallback. */
async function closeParentAndReport(parentIssue: number): Promise<string> {
  try {
    await closeIssueAndDispatch({ number: parentIssue });
    return JSON.stringify({ merged: true, closed_issue: parentIssue });
  } catch (e) {
    log(`mergePr: could not close parent issue #${parentIssue}: ${e}`);
    return JSON.stringify({ merged: true, closed_issue: null });
  }
}

const { tools: TOOLS, dispatch } = buildMcpTools([
  defineMcpTool({
    name: "create_issue",
    description: "Create a GitHub issue in the current repository and return its number and URL. Use this for durable work items, especially delegated child tasks; sub_issue defaults to true and links the new issue to the current issue. This mutates GitHub and records the operation in Atoma's audit log.",
    schema: CREATE_ISSUE_SCHEMA,
    handler: createIssue,
  }),
  defineMcpTool({ name: "get_issue", description: "Retrieve one issue's title, body, state, labels, timestamps, and comments by issue number. Use this when full issue context is needed; for scanning multiple issues, use list_issues instead. Returns a JSON issue object and does not mutate GitHub.", schema: ISSUE_CONTEXT_NUMBER_ARG_SCHEMA, handler: getIssue }),
  defineMcpTool({ name: "list_issues", description: "List issue summaries in the current repository, optionally filtered by state and labels. Use this to discover or scan issues; use get_issue when full body and comments are needed. Returns a JSON array and does not mutate GitHub.", schema: LIST_ISSUES_SCHEMA, handler: listIssues }),
  defineMcpTool({ name: "get_issue_comments", description: "Retrieve only the comments for one issue. Use this when conversation history is needed without the rest of the issue payload. Returns a JSON array in chronological GitHub order and does not mutate GitHub.", schema: ISSUE_CONTEXT_NUMBER_ARG_SCHEMA, handler: getIssueComments }),
  defineMcpTool({ name: "close_issue", description: "Close a bot-created issue and trigger Atoma parent-task aggregation when applicable. Use only after the issue's work is complete; the tool refuses to close human-created issues. Returns JSON success status and mutates GitHub.", schema: NUMBER_ARG_SCHEMA, handler: closeIssueAndDispatch }),
  defineMcpTool({ name: "create_pr", description: "Create a pull request from the checked-out Atoma branch and return its number and URL. Call commit_and_push first: this tool requires a clean worktree and exact local/remote HEAD equality, and it never pushes for you. On success it dispatches the configured reviewer and ends the current agent session.", schema: CREATE_PR_SCHEMA, handler: createPr }),
  defineMcpTool({ name: "get_pr", description: "Retrieve one pull request's metadata, including state and base/head branches. Use this for PR status and identity; use get_pr_diff or review tools for code and review details. Returns a JSON object and does not mutate GitHub.", schema: NUMBER_ARG_SCHEMA, handler: getPr }),
  defineMcpTool({ name: "get_pr_diff", description: "Retrieve the unified diff for one pull request, truncated to 50,000 characters. Use this to review code changes; it does not include review conversations. Returns plain diff text and does not mutate GitHub.", schema: NUMBER_ARG_SCHEMA, handler: getPrDiff }),
  defineMcpTool({ name: "list_prs", description: "List pull request summaries in the current repository, optionally filtered by state. Use this to discover PRs; use get_pr for full metadata. Returns a JSON array and does not mutate GitHub.", schema: LIST_PRS_SCHEMA, handler: listPrs }),
  defineMcpTool({ name: "search_code", description: "Search code through GitHub within the current repository. Use this for remote repository text or symbol discovery when local filesystem search is unavailable; do not use it for uncommitted changes. Returns GitHub CLI search text, truncated to 50,000 characters.", schema: SEARCH_CODE_SCHEMA, handler: searchCode }),
  defineMcpTool({ name: "get_branch", description: "Retrieve GitHub's branch metadata for an exact branch name. Use this to inspect remote branch identity and protection information, not local worktree state. Returns a JSON branch object and does not mutate GitHub.", schema: GET_BRANCH_SCHEMA, handler: getBranch }),
  defineMcpTool({
    name: "sync_branch",
    description: "Synchronize the checked-out branch with its remote counterpart and report ahead/behind status. Use this after a non-fast-forward push failure or before retrying branch publication; it fast-forwards only when safe. It never rebases or force-pushes, and reports diverged branches for explicit resolution.",
    schema: SYNC_BRANCH_SCHEMA,
    handler: syncBranch,
  }),
  defineMcpTool({ name: "get_check_runs", description: "Retrieve GitHub Actions and other check runs for a commit, branch, or tag. Use this to verify CI status after pushing or before merge decisions. Returns a JSON array of check-run objects and does not wait for incomplete checks.", schema: GET_CHECK_RUNS_SCHEMA, handler: getCheckRuns }),
  defineMcpTool({
    name: "check_merge_readiness",
    description:
      "Report whether a pull request can be merged right now, and every reason it cannot: failing checks (by name, with a link), still-running checks, an absent CI run, merge conflicts, draft state, or a non-auto merge policy. Call this before github__merge_pr, and to explain a refused merge. When the only thing missing is a CI run on the head commit, this dispatches CI and says so — re-check afterwards rather than merging blind. Read-only apart from that dispatch.",
    schema: ISSUE_CONTEXT_NUMBER_ARG_SCHEMA,
    handler: checkMergeReadiness,
  }),
  defineMcpTool({ name: "get_pr_reviews", description: "Retrieve submitted review summaries for one pull request. Use this to inspect review decisions and bodies; use list_pr_review_comments for line-level code comments. Returns a JSON array and does not mutate GitHub.", schema: NUMBER_ARG_SCHEMA, handler: getPrReviews }),
  defineMcpTool({ name: "list_pr_review_comments", description: "Retrieve line-level review comments for one pull request. Use this to find file- and line-specific feedback; use get_pr_reviews for overall review decisions. Returns a JSON array and does not mutate GitHub.", schema: NUMBER_ARG_SCHEMA, handler: listPrReviewComments }),
  defineMcpTool({
    name: "submit_pr_review",
    description: "Submit a pull request review as either a general COMMENT or REQUEST_CHANGES. Use this after inspecting the diff and checks; APPROVE is intentionally unavailable because all Atoma agents share the PR author's bot identity. This mutates GitHub and returns JSON success status.",
    schema: SUBMIT_PR_REVIEW_SCHEMA,
    handler: submitPrReview,
  }),
  defineMcpTool({
    name: "commit_and_push",
    description: "Stage all worktree changes, create one commit, and push the checked-out branch to origin. Use this after validation and before create_pr; do not call it with unrelated or unreviewed changes present. Returns JSON success status and fails rather than rewriting remote history.",
    schema: COMMIT_AND_PUSH_SCHEMA,
    handler: commitAndPush,
  }),
  defineMcpTool({
    name: "merge_pr",
    description: "Merge a pull request, then continue Atoma's issue handoff. Refuses and returns merged:false with a `blockers` list whenever the PR is not mergeable: CI not green on the head commit, no CI run at all, conflicts, draft state, or merge_policy not 'auto'. It never merges past a failing check, so a refusal is a real defect to fix, not a condition to retry around — read `blockers`, and use github__check_merge_readiness for detail. On success this may merge the PR, close its linked issue, and dispatch follow-up work.",
    schema: NUMBER_ARG_SCHEMA,
    handler: mergePr,
  }),
]);

const server = new Server(
  { name: "atoma-github-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const { text, meta } = await dispatch(name, args);
    return {
      content: [{ type: "text", text }],
      isError: false,
      ...(meta ? { _meta: meta } : {}),
    };
  } catch (e) {
    log(`Tool error: ${e}`);
    return { content: [{ type: "text", text: `Error: ${(e as Error).message ?? e}` }], isError: true };
  }
});

async function main(): Promise<void> {
  log(`Starting for ${REPO}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) void main();

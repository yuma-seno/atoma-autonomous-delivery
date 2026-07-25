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
 * always `console.error()` (`log()` below) for logging. See
 * request_close_issue.ts's doc comment for the real incident this guards
 * against (a stray console.log corrupted the stdio stream and broke real
 * tool calls with an opaque "Failed to call tool" error).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { gh, ghGraphql, gitRun } from "../../../../lib/gh.ts";
import { getLabel, getMergePolicy, getTriggerAgent } from "../../../../lib/config.ts";
import { resolveNotify } from "../../../../lib/notify.ts";
import { dispatchOrchestratorIfSubIssueReady } from "../../../../lib/aggregation.ts";
import { logDispatch, logOp } from "../../../../lib/ops-log.ts";
import { LLM_CONTEXT_TAG, NOTIFY_TAG, ORIGIN_AGENT_TAG, PARENT_ISSUE_TAG, PARENT_TAG } from "../../../../lib/tags.ts";
import type { GhIssueAuthor } from "../../../../lib/types.ts";
import { buildMcpTools, defineMcpTool, z, type McpToolResult } from "../../../../lib/mcp-tool.ts";
import { decidePostMergeHandoff } from "../../../../domain/handoff.ts";

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

/** Shared schema for tools that take a single required `number` (issue/PR number) argument. */
const NUMBER_ARG_SCHEMA = z.object({ number: z.number().int() });

const CREATE_ISSUE_SCHEMA = z.object({
  title: z.string(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  sub_issue: z
    .boolean()
    .optional()
    .describe("Set sub_issue=true to automatically link it to the current issue as a child task. Defaults to true."),
});

const LIST_ISSUES_SCHEMA = z.object({
  state: z.enum(["open", "closed", "all"]).optional(),
  labels: z.array(z.string()).optional(),
  limit: z.number().int().optional(),
});

const CREATE_PR_SCHEMA = z.object({
  title: z.string(),
  body: z.string().optional(),
  base: z.string().optional(),
});

const LIST_PRS_SCHEMA = z.object({
  state: z.enum(["open", "closed", "merged", "all"]).optional(),
  limit: z.number().int().optional(),
});

const SEARCH_CODE_SCHEMA = z.object({ query: z.string() });
const GET_BRANCH_SCHEMA = z.object({ name: z.string() });
const GET_CHECK_RUNS_SCHEMA = z.object({ ref: z.string() });

const SUBMIT_PR_REVIEW_SCHEMA = z.object({
  number: z.number().int(),
  event: z.enum(["COMMENT", "REQUEST_CHANGES"]),
  body: z.string().optional(),
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
    if (!labels.includes(subIssueLabel)) labels = [...labels, subIssueLabel];
  }

  const cmd = ["issue", "create", "--repo", REPO, "--title", title];
  if (body) cmd.push("--body", body);
  for (const l of labels) cmd.push("--label", l);

  const { code, stdout, stderr } = gh(...cmd);
  if (code) mcpFail(stderr || stdout);
  const num = Number(stdout.trim().split("/").pop());

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

function getIssue(a: z.infer<typeof NUMBER_ARG_SCHEMA>): string {
  return JSON.stringify(ghJsonOrThrow("issue", "view", String(a.number), "--repo", REPO, "--json", "number,title,body,state,labels,createdAt,closedAt,comments"));
}

function listIssues(a: z.infer<typeof LIST_ISSUES_SCHEMA>): string {
  const state = a.state ?? "open";
  const limit = a.limit ?? 30;
  const labels = a.labels ?? [];
  const cmd = ["issue", "list", "--repo", REPO, "--state", state, "--limit", String(limit), "--json", "number,title,state,labels"];
  for (const l of labels) cmd.push("--label", l);
  return JSON.stringify(ghJsonOrThrow(...cmd) ?? []);
}

function getIssueComments(a: z.infer<typeof NUMBER_ARG_SCHEMA>): string {
  const d = ghJsonOrThrow<{ comments?: unknown[] }>("issue", "view", String(a.number), "--repo", REPO, "--json", "comments");
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
 * Directly dispatch whichever agent config.json's auto_triggers designates
 * for a newly opened PR ("pull_request.opened", normally "reviewer" -- but
 * read from config, never hardcoded). GitHub suppresses further
 * workflow-triggering events for actions performed with the default
 * GITHUB_TOKEN, so a bot-created PR does NOT reliably cause
 * atoma-auto-trigger.yml to fire. workflow_dispatch is exempt from that
 * restriction, so dispatch directly here, the same way launch_sub_agent.ts
 * does for orchestrator -> sub-agent handoffs. Best-effort: a dispatch
 * failure does not fail PR creation itself.
 */
function dispatchPostPrAgent(prNumber: number): void {
  const agent = getTriggerAgent("pull_request.opened", "reviewer");
  const dispatchWorkflow = process.env.ATOMA_DISPATCH_WORKFLOW ?? "atoma-runner.yml";
  const { code, stdout, stderr } = gh(
    "workflow", "run", dispatchWorkflow,
    "--field", `agent=${agent}`,
    "--field", `number=${prNumber}`,
    "--field", "type=pr",
    "--field", `notify=${(process.env.ISSUE_NOTIFY ?? "").trim()}`,
  );
  if (code) {
    log(`dispatchPostPrAgent: WARN failed to dispatch ${agent} for PR #${prNumber}: ${stderr || stdout}`);
  } else {
    log(`dispatchPostPrAgent: dispatched ${agent} for PR #${prNumber}`);
    logDispatch("pr", agent, { number: prNumber });
  }
}

function createPr(a: z.infer<typeof CREATE_PR_SCHEMA>): McpToolResult {
  const title = a.title;
  let body = a.body ?? "";
  const base = a.base;
  body = injectParentIssue(body);
  log(`createPr: title=${JSON.stringify(title)}, base=${JSON.stringify(base)}, REPO=${JSON.stringify(REPO)}`);

  const branch = resolveBranch();
  log(`createPr: resolved branch=${JSON.stringify(branch)}`);

  const push = gitRun("push", "-u", "origin", branch);
  log(`createPr: git push rc=${push.code}, err=${JSON.stringify(push.stderr)}`);
  if (push.code) mcpFail(`git push failed (rc=${push.code}): ${push.stderr || push.stdout}`);

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
  dispatchPostPrAgent(num);

  // Traceability: the reviewer dispatch above is fire-and-forget, and (since
  // this call now ends the session immediately, see the returned
  // meta.session_ends below) no further agent text will be posted on the
  // CURRENT issue about this -- record it here explicitly, the same way
  // launch_sub_agent.ts always confirms its own dispatch with a comment.
  const currentIssue = (process.env.ISSUE_NUMBER ?? "").trim();
  if (currentIssue) {
    gh(
      "issue", "comment", currentIssue, "--repo", REPO,
      "--body", `${LLM_CONTEXT_TAG.write("exclude")}\nAtoma: PR #${num} created (${stdout.trim()}). Dispatching reviewer.`,
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
  return JSON.stringify({ ok: true });
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

/**
 * After a PR merges, re-invoke the agent that originally created it (tagged
 * via <!-- atoma:origin-agent=... --> in the PR body, see injectParentIssue)
 * on the linked sub-issue, instead of silently closing the sub-issue
 * ourselves. Returns true if the dispatch was sent (best-effort; a failure
 * here should not fail merge_pr itself -- caller falls back to closing
 * directly).
 */
/** True if `number` is currently closed (used to skip a pointless post-merge re-invocation when native "Closes #N" auto-close already did the job). */
function isIssueClosed(number: number): boolean {
  const d = ghJsonOrThrow<{ state?: string }>("issue", "view", String(number), "--repo", REPO, "--json", "state");
  return (d?.state ?? "").toUpperCase() === "CLOSED";
}

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
  const { code, stdout, stderr } = gh(
    "workflow", "run", "atoma-runner.yml",
    "--repo", REPO,
    "--field", `agent=${agent}`,
    "--field", `number=${subIssueNum}`,
    "--field", "type=issue",
    "--field", `notify=${notify}`,
  );
  if (code) {
    log(`dispatchPostMergeAgent: gh workflow run failed for #${subIssueNum} (rc=${code}): ${stderr || stdout}`);
    return false;
  }
  log(`dispatchPostMergeAgent: re-invoked ${agent} on #${subIssueNum} to confirm and close`);
  logDispatch("issue", agent, { number: subIssueNum });
  return true;
}

async function mergePr(a: z.infer<typeof NUMBER_ARG_SCHEMA>): Promise<string> {
  const num = a.number;
  const policy = getMergePolicy();
  if (policy !== "auto") {
    log(`mergePr: merge_policy=${JSON.stringify(policy)}, not 'auto' — skipping merge for PR #${num}`);
    return JSON.stringify({ merged: false, reason: `merge_policy is '${policy}', not 'auto'` });
  }
  const { code, stdout, stderr } = gh("pr", "merge", String(num), "--repo", REPO, "--squash");
  log(`mergePr: gh pr merge rc=${code}, out=${JSON.stringify(stdout)}, err=${JSON.stringify(stderr)}`);
  if (code) mcpFail(`gh pr merge failed (rc=${code}): ${stderr || stdout}`);
  logOp("merge_pr", { number: num });

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
    description: "Create a new GitHub issue. Set sub_issue=true to automatically link it to the current issue as a child task.",
    schema: CREATE_ISSUE_SCHEMA,
    handler: createIssue,
  }),
  defineMcpTool({ name: "get_issue", description: "Get an issue by number.", schema: NUMBER_ARG_SCHEMA, handler: getIssue }),
  defineMcpTool({ name: "list_issues", description: "List issues.", schema: LIST_ISSUES_SCHEMA, handler: listIssues }),
  defineMcpTool({ name: "get_issue_comments", description: "Get issue comments.", schema: NUMBER_ARG_SCHEMA, handler: getIssueComments }),
  defineMcpTool({ name: "close_issue", description: "Close an issue. Refuses to close issues opened by humans.", schema: NUMBER_ARG_SCHEMA, handler: closeIssueAndDispatch }),
  defineMcpTool({ name: "create_pr", description: "Create a pull request from the current branch.", schema: CREATE_PR_SCHEMA, handler: createPr }),
  defineMcpTool({ name: "get_pr", description: "Get a PR by number.", schema: NUMBER_ARG_SCHEMA, handler: getPr }),
  defineMcpTool({ name: "get_pr_diff", description: "Get PR diff.", schema: NUMBER_ARG_SCHEMA, handler: getPrDiff }),
  defineMcpTool({ name: "list_prs", description: "List PRs.", schema: LIST_PRS_SCHEMA, handler: listPrs }),
  defineMcpTool({ name: "search_code", description: "Search code.", schema: SEARCH_CODE_SCHEMA, handler: searchCode }),
  defineMcpTool({ name: "get_branch", description: "Get branch info.", schema: GET_BRANCH_SCHEMA, handler: getBranch }),
  defineMcpTool({ name: "get_check_runs", description: "Get check runs for a ref.", schema: GET_CHECK_RUNS_SCHEMA, handler: getCheckRuns }),
  defineMcpTool({ name: "get_pr_reviews", description: "Get PR reviews.", schema: NUMBER_ARG_SCHEMA, handler: getPrReviews }),
  defineMcpTool({ name: "list_pr_review_comments", description: "List PR review comments.", schema: NUMBER_ARG_SCHEMA, handler: listPrReviewComments }),
  defineMcpTool({
    name: "submit_pr_review",
    description: "Submit a PR review (comment or request changes). Note: APPROVE is not usable — Atoma agents share a single bot identity, and GitHub refuses to let an account approve its own pull request.",
    schema: SUBMIT_PR_REVIEW_SCHEMA,
    handler: submitPrReview,
  }),
  defineMcpTool({
    name: "commit_and_push",
    description: "Stage all changes, commit with a message, and push to the current branch.",
    schema: COMMIT_AND_PUSH_SCHEMA,
    handler: commitAndPush,
  }),
  defineMcpTool({
    name: "merge_pr",
    description: "Merge a PR if config.json's merge_policy is 'auto'. No-op (returns merged:false) when the policy is 'manual' or anything else — call this after posting your LGTM comment and it will decide for you.",
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

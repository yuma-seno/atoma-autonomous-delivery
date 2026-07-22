#!/usr/bin/env bun
/**
 * github.ts — Unified GitHub MCP server for Atoma.
 *
 * Transport: stdio, via the official @modelcontextprotocol/sdk.
 * Dependencies: `gh` CLI + `git`.
 *
 * Every mutation is logged to $ATOMA_OPS_LOG for dispatch-next to consume.
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { gh, ghGraphql, gitRun } from "../lib/gh.ts";
import { getLabel, getMergePolicy, getTriggerAgent } from "../lib/config.ts";
import type { GhIssueAuthor } from "../lib/types.ts";

// This file lives in scripts/mcp/, but the sibling one-shot scripts it
// shells out to (dispatch_orchestrator_if_ready.ts, resolve_notify.ts) live
// one level up in scripts/ itself.
const SCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

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

const OPS_LOG = process.env.ATOMA_OPS_LOG ?? "/tmp/atoma_ops.log";

function opsLog(op: string, payload: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), op, ...payload };
  try {
    appendFileSync(OPS_LOG, JSON.stringify(entry) + "\n");
  } catch (e) {
    log(`WARN: ops_log failed: ${e}`);
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

const TOOLS: Tool[] = [
  { name: "create_issue", description: "Create a new GitHub issue. Set sub_issue=true to automatically link it to the current issue as a child task.", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } }, sub_issue: { type: "boolean", description: "Set sub_issue=true to automatically link it to the current issue as a child task. Defaults to true." } }, required: ["title"] } },
  { name: "get_issue", description: "Get an issue by number.", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] } },
  { name: "list_issues", description: "List issues.", inputSchema: { type: "object", properties: { state: { type: "string", enum: ["open", "closed", "all"] }, labels: { type: "array", items: { type: "string" } }, limit: { type: "integer" } } } },
  { name: "get_issue_comments", description: "Get issue comments.", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] } },
  { name: "close_issue", description: "Close an issue. Refuses to close issues opened by humans.", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] } },
  { name: "create_pr", description: "Create a pull request from the current branch.", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, base: { type: "string" } }, required: ["title"] } },
  { name: "get_pr", description: "Get a PR by number.", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] } },
  { name: "get_pr_diff", description: "Get PR diff.", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] } },
  { name: "list_prs", description: "List PRs.", inputSchema: { type: "object", properties: { state: { type: "string", enum: ["open", "closed", "merged", "all"] }, limit: { type: "integer" } } } },
  { name: "search_code", description: "Search code.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_branch", description: "Get branch info.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "get_check_runs", description: "Get check runs for a ref.", inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "get_pr_reviews", description: "Get PR reviews.", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] } },
  { name: "list_pr_review_comments", description: "List PR review comments.", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] } },
  { name: "submit_pr_review", description: "Submit a PR review (comment or request changes). Note: APPROVE is not usable — Atoma agents share a single bot identity, and GitHub refuses to let an account approve its own pull request.", inputSchema: { type: "object", properties: { number: { type: "integer" }, event: { type: "string", enum: ["COMMENT", "REQUEST_CHANGES"] }, body: { type: "string" } }, required: ["number", "event"] } },
  { name: "commit_and_push", description: "Stage all changes, commit with a message, and push to the current branch.", inputSchema: { type: "object", properties: { message: { type: "string", description: "Commit message." } }, required: ["message"] } },
  { name: "merge_pr", description: "Merge a PR if config.json's merge_policy is 'auto'. No-op (returns merged:false) when the policy is 'manual' or anything else — call this after posting your LGTM comment and it will decide for you.", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] } },
];

function notifyTagPrefix(): string {
  const login = (process.env.ISSUE_NOTIFY ?? "").trim();
  return login ? `<!-- atoma:notify=${login} -->\n` : "";
}

async function createIssue(a: Record<string, unknown>): Promise<string> {
  const title = a.title as string;
  let body = (a.body as string) ?? "";
  let labels = (a.labels as string[]) ?? [];
  const sub = (a.sub_issue as boolean | undefined) ?? true;
  const parentNum = (process.env.ISSUE_NUMBER ?? "").trim();

  body = notifyTagPrefix() + body;
  if (sub) {
    if (parentNum) body = `<!-- atoma:parent=#${parentNum} -->\n${body}`;
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

  opsLog("create_issue", { number: num, title, sub_issue: sub });
  return JSON.stringify({ number: num, url: stdout.trim() });
}

function getIssue(a: Record<string, unknown>): string {
  return JSON.stringify(ghJsonOrThrow("issue", "view", String(a.number), "--repo", REPO, "--json", "number,title,body,state,labels,createdAt,closedAt,comments"));
}

function listIssues(a: Record<string, unknown>): string {
  const state = (a.state as string) ?? "open";
  const limit = (a.limit as number) ?? 30;
  const labels = (a.labels as string[]) ?? [];
  const cmd = ["issue", "list", "--repo", REPO, "--state", state, "--limit", String(limit), "--json", "number,title,state,labels"];
  for (const l of labels) cmd.push("--label", l);
  return JSON.stringify(ghJsonOrThrow(...cmd) ?? []);
}

function getIssueComments(a: Record<string, unknown>): string {
  const d = ghJsonOrThrow<{ comments?: unknown[] }>("issue", "view", String(a.number), "--repo", REPO, "--json", "comments");
  return JSON.stringify(d?.comments ?? []);
}

function closeIssue(a: Record<string, unknown>): string {
  const num = a.number as number;
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
  opsLog("close_issue", { number: num });
  // Whether this is a sub-issue closed via the normal merge_pr path or via an
  // origin-agent re-invocation confirming its own work, phase-gating/
  // aggregation must be checked here so it fires regardless of which path
  // closed the issue. dispatchOrchestratorIfReady no-ops harmlessly if #num
  // has no atoma:parent tag.
  try {
    dispatchOrchestratorIfReady(num);
  } catch (e) {
    log(`closeIssue: dispatchOrchestratorIfReady failed for #${num}: ${e}`);
  }
  return JSON.stringify({ ok: true });
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
  if (body.includes("<!-- atoma:notify=")) mcpFail("PR body already contains a notify tag; refusing to add another");
  body = notifyTagPrefix() + body;
  if (!parent) return body;
  if (body.includes("<!-- atoma:parent-issue=")) {
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
  const originLine = originAgent ? `<!-- atoma:origin-agent=${originAgent} -->\n` : "";
  return `<!-- atoma:parent-issue=${parent} -->\n${originLine}${closesLine}${body}`;
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
  if (code) log(`dispatchPostPrAgent: WARN failed to dispatch ${agent} for PR #${prNumber}: ${stderr || stdout}`);
  else log(`dispatchPostPrAgent: dispatched ${agent} for PR #${prNumber}`);
}

function createPr(a: Record<string, unknown>): string {
  const title = a.title as string;
  let body = (a.body as string) ?? "";
  const base = a.base as string | undefined;
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

  opsLog("create_pr", { number: num, title });
  dispatchPostPrAgent(num);
  return JSON.stringify({ number: num, url: stdout.trim() });
}

function commitAndPush(a: Record<string, unknown>): string {
  const message = a.message as string;
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
  opsLog("commit_and_push", {});
  return JSON.stringify({ ok: true });
}

function getPr(a: Record<string, unknown>): string {
  return JSON.stringify(ghJsonOrThrow("pr", "view", String(a.number), "--repo", REPO, "--json", "number,title,body,state,baseRefName,headRefName,createdAt"));
}

function getPrDiff(a: Record<string, unknown>): string {
  const { code, stdout, stderr } = gh("pr", "diff", String(a.number), "--repo", REPO);
  if (code) mcpFail(stderr || stdout);
  return stdout.slice(0, 50000);
}

function listPrs(a: Record<string, unknown>): string {
  const state = (a.state as string) ?? "open";
  const limit = (a.limit as number) ?? 30;
  return JSON.stringify(ghJsonOrThrow("pr", "list", "--repo", REPO, "--state", state, "--limit", String(limit), "--json", "number,title,state,headRefName,baseRefName") ?? []);
}

function searchCode(a: Record<string, unknown>): string {
  const { code, stdout, stderr } = gh("search", "code", a.query as string, "--repo", REPO, "--limit", "30");
  if (code) mcpFail(stderr || stdout);
  return stdout.slice(0, 50000);
}

function getBranch(a: Record<string, unknown>): string {
  return JSON.stringify(ghJsonOrThrow("api", `repos/${REPO}/branches/${a.name}`));
}

function getCheckRuns(a: Record<string, unknown>): string {
  const d = ghJsonOrThrow<{ check_runs?: unknown[] }>("api", `repos/${REPO}/commits/${a.ref}/check-runs`);
  return JSON.stringify(d?.check_runs ?? []);
}

function getPrReviews(a: Record<string, unknown>): string {
  const d = ghJsonOrThrow<{ reviews?: unknown[] }>("pr", "view", String(a.number), "--repo", REPO, "--json", "reviews");
  return JSON.stringify(d?.reviews ?? []);
}

function listPrReviewComments(a: Record<string, unknown>): string {
  return JSON.stringify(ghJsonOrThrow(`api`, `repos/${REPO}/pulls/${a.number}/comments`) ?? []);
}

function submitPrReview(a: Record<string, unknown>): string {
  let event = a.event as string;
  if (event === "APPROVE") {
    // GitHub always rejects self-approval since all Atoma agents share the
    // same bot identity ("Can not approve your own pull request"). Rewrite
    // to COMMENT instead of letting the gh call fail.
    log(`submitPrReview: rewriting event APPROVE -> COMMENT for PR #${a.number} (self-approval is never possible)`);
    event = "COMMENT";
  }
  const cmd = ["pr", "review", String(a.number), "--repo", REPO, "--" + event.toLowerCase()];
  if (a.body) cmd.push("--body", a.body as string);
  const { code, stdout, stderr } = gh(...cmd);
  if (code) mcpFail(stderr || stdout);
  opsLog("submit_pr_review", { number: a.number, event });
  return JSON.stringify({ ok: true });
}

/**
 * Thin wrapper around the standalone dispatch_orchestrator_if_ready.ts
 * script. Extracted out so request_close_issue.ts (used by the
 * orchestrator's request_close_issue tool) can trigger the exact same
 * phase-gating logic as this module's own closeIssue, without duplicating it.
 */
function dispatchOrchestratorIfReady(subIssueNum: number): void {
  Bun.spawnSync({
    cmd: ["bun", "run", join(SCRIPT_DIR, "dispatch_orchestrator_if_ready.ts"), "--repo", REPO, "--issue", String(subIssueNum)],
    stdout: "inherit",
    stderr: "inherit",
  });
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
  const notifyOut = Bun.spawnSync({
    cmd: ["bun", "run", join(SCRIPT_DIR, "resolve_notify.ts"), "--repo", REPO, "--number", String(subIssueNum)],
    stdout: "pipe",
  });
  const notify = notifyOut.stdout.toString("utf8").trim();
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
  return true;
}

function mergePr(a: Record<string, unknown>): string {
  const num = a.number as number;
  const policy = getMergePolicy();
  if (policy !== "auto") {
    log(`mergePr: merge_policy=${JSON.stringify(policy)}, not 'auto' — skipping merge for PR #${num}`);
    return JSON.stringify({ merged: false, reason: `merge_policy is '${policy}', not 'auto'` });
  }
  const { code, stdout, stderr } = gh("pr", "merge", String(num), "--repo", REPO, "--squash");
  log(`mergePr: gh pr merge rc=${code}, out=${JSON.stringify(stdout)}, err=${JSON.stringify(stderr)}`);
  if (code) mcpFail(`gh pr merge failed (rc=${code}): ${stderr || stdout}`);
  opsLog("merge_pr", { number: num });

  // GitHub's native "Closes #N" auto-close does not reliably fire when the
  // merge is performed via the Actions GITHUB_TOKEN. Prefer re-invoking the
  // PR's origin agent to close the sub-issue itself; only fall back to
  // closing it directly here if there's no origin-agent tag to dispatch.
  let closedIssue: number | null = null;
  const d = ghJsonOrThrow<{ body?: string }>("pr", "view", String(num), "--repo", REPO, "--json", "body");
  const body = d?.body ?? "";
  const m = /<!--\s*atoma:parent-issue=(\d+)\s*-->/.exec(body);
  if (m) {
    const parentNum = Number(m[1]);
    const originMatch = /<!--\s*atoma:origin-agent=([a-z][a-z0-9-]*)\s*-->/.exec(body);
    if (originMatch && dispatchPostMergeAgent(parentNum, originMatch[1]!)) {
      return JSON.stringify({ merged: true, closed_issue: null, reinvoked_agent: originMatch[1] });
    }
    try {
      // closeIssue now triggers dispatchOrchestratorIfReady itself.
      closeIssue({ number: parentNum });
      closedIssue = parentNum;
    } catch (e) {
      log(`mergePr: could not close parent issue #${parentNum}: ${e}`);
    }
  }
  return JSON.stringify({ merged: true, closed_issue: closedIssue });
}

const TOOL_HANDLERS: Record<string, (a: Record<string, unknown>) => string | Promise<string>> = {
  create_issue: createIssue,
  get_issue: getIssue,
  list_issues: listIssues,
  get_issue_comments: getIssueComments,
  close_issue: closeIssue,
  create_pr: createPr,
  get_pr: getPr,
  get_pr_diff: getPrDiff,
  list_prs: listPrs,
  search_code: searchCode,
  get_branch: getBranch,
  get_check_runs: getCheckRuns,
  get_pr_reviews: getPrReviews,
  list_pr_review_comments: listPrReviewComments,
  submit_pr_review: submitPrReview,
  commit_and_push: commitAndPush,
  merge_pr: mergePr,
};

const server = new Server(
  { name: "atoma-github-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const fn = TOOL_HANDLERS[name];
  if (!fn) {
    return { content: [{ type: "text", text: `Unknown: ${name}` }], isError: true };
  }
  try {
    const text = await fn(args);
    return { content: [{ type: "text", text }], isError: false };
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

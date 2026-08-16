/**
 * branch-placement.ts — which branch a run's work goes on, and what its pull
 * request aims at.
 *
 * The naming rule itself is pure and lives in `domain/issue-branch.ts`. What is
 * here is everything that has to ask git or GitHub to apply it: whether a branch
 * already exists, whether this issue has a parent, where a new branch should be
 * cut from, and whether a parent's branch is there to stack on.
 *
 * `repo` is passed rather than read from the environment, so the decision is
 * never quietly about a different repository than the caller meant.
 */
import { gh, gitRun } from "./gh.ts";
import { PARENT_TAG } from "./tags.ts";
import { nextBranchName } from "../domain/issue-branch.ts";
import { collectIssueBranches } from "./issue-branches.ts";

function log(message: string): void {
  console.error(`[atoma-github] ${message}`);
}

/** The prefix every Atoma work branch carries; also how a parent's branch is named. */
const BRANCH_PREFIX = "atoma/issue-";

/** A parent issue's branch name. */
export function branchOfIssue(issue: number): string {
  return `${BRANCH_PREFIX}${issue}`;
}

/** Whether a branch name is one of Atoma's work branches. */
export function isIssueBranch(name: string): boolean {
  return name.startsWith(BRANCH_PREFIX);
}

/** The branch this run is checked out on, however it can be determined. */
export function resolveBranch(): string {
  const fromEnv = (process.env.BRANCH ?? "").trim();
  if (fromEnv && fromEnv !== "HEAD") return fromEnv;
  {
    const { code, stdout } = gitRun("rev-parse", "--abbrev-ref", "HEAD");
    if (code === 0 && stdout && stdout !== "HEAD") return stdout;
  }
  {
    const { code, stdout } = gitRun("branch", "--format=%(refname:short)", "--points-at=HEAD");
    if (code === 0 && stdout) return stdout.split("\n")[0]!;
  }
  throw new Error("Cannot determine branch name; set BRANCH env");
}

/**
 * The parent issue this one was split out of, or 0 for a root issue.
 *
 * Read from the issue body's `atoma:parent` tag, which `create_issue` writes
 * when an orchestrator creates a child. Nothing here asks which agent is
 * running: a sub-issue is a sub-issue whoever picks it up.
 */
export function parentIssueOf(repo: string, issue: number): number {
  const { code, stdout } = gh("issue", "view", String(issue), "--repo", repo, "--json", "body", "--jq", ".body");
  if (code) {
    log(`WARN could not read issue #${issue}; treating it as a root issue`);
    return 0;
  }
  return PARENT_TAG.read(stdout) ?? 0;
}

/**
 * The branch a sub-issue's work should be cut from, or "" for the base branch.
 *
 * Sub-issues of one parent are split from a single piece of work and usually
 * depend on each other — an interface one defines is what the next one consumes.
 * Cutting each from the base hides those from one another until every part has
 * landed separately, which is where integration surprises come from.
 *
 * So they stack: each is cut from the parent's branch and merges back into it,
 * and the parent's branch reaches the base as one reviewed change. The parent's
 * branch is created here, empty, if the first child gets there first — an
 * orchestrator plans and dispatches without committing, so its branch would
 * otherwise not exist yet.
 *
 * Best-effort throughout. Every failure returns "" and the work is cut from the
 * base, which is the behaviour before stacking existed: a slower integration is
 * not worth failing a commit over.
 */
export function stackedBaseFor(repo: string, issue: number): string {
  const parent = parentIssueOf(repo, issue);
  if (!parent) return "";

  const parentBranch = branchOfIssue(parent);
  const existing = gitRun("ls-remote", "--heads", "origin", `refs/heads/${parentBranch}`);
  if (existing.code === 0 && existing.stdout.trim()) {
    const fetched = gitRun("fetch", "origin", `refs/heads/${parentBranch}:refs/remotes/origin/${parentBranch}`);
    if (fetched.code) {
      log(`WARN could not fetch ${parentBranch}; cutting from the base branch instead`);
      return "";
    }
    return parentBranch;
  }

  // The parent has no branch yet. Create it where this run started, which is the
  // base branch — the run resumed nothing, or `branchForCommit` would not be
  // naming a branch at all.
  const head = gitRun("rev-parse", "HEAD");
  if (head.code) return "";
  const { code, stderr, stdout } = gh(
    "api", `repos/${repo}/git/refs`, "-X", "POST",
    "-f", `ref=refs/heads/${parentBranch}`, "-f", `sha=${head.stdout.trim()}`,
  );
  if (code) {
    log(`WARN could not create ${parentBranch}: ${stderr || stdout}; cutting from the base branch instead`);
    return "";
  }
  const fetched = gitRun("fetch", "origin", `refs/heads/${parentBranch}:refs/remotes/origin/${parentBranch}`);
  if (fetched.code) return "";
  log(`commitAndPush: created parent branch ${parentBranch} for #${parent}`);
  return parentBranch;
}

/**
 * The branch this commit belongs on, creating one if the run has none yet.
 *
 * A run starts on the base branch unless it had work to resume, because most
 * runs never commit and creating a branch for those left one behind every time.
 * The first commit is what turns a run into work, so that is where the branch
 * appears.
 *
 * When every earlier branch for this issue has merged, the name counts up:
 * reusing a merged branch would build on history the base already contains.
 */
export function branchForCommit(repo: string): string {
  const current = gitRun("rev-parse", "--abbrev-ref", "HEAD");
  const onBranch = current.code === 0 ? current.stdout.trim() : "";
  if (isIssueBranch(onBranch)) return onBranch;

  // Only an issue run may name a branch. On a pull request run `ISSUE_NUMBER`
  // holds the PR's number and the checkout is already the branch under review,
  // so naming one from it would move the work off the pull request.
  const issue = runIssueNumber();
  if (issue === undefined) return resolveBranch();

  const from = stackedBaseFor(repo, issue);
  const name = nextBranchName(collectIssueBranches(repo, issue), issue);
  const created = from
    ? gitRun("checkout", "-b", name, `origin/${from}`)
    : gitRun("checkout", "-b", name);
  if (created.code) throw new Error(`Could not create branch '${name}': ${created.stderr || created.stdout}`);
  log(`commitAndPush: created branch ${name}${from ? ` from ${from}` : ""}`);
  return name;
}

/**
 * The parent's branch, when this run is a sub-issue's and that branch exists.
 *
 * Returns undefined for a root issue, and for a sub-issue whose parent branch
 * was never created — a run that reports rather than commits reaches no
 * `commit_and_push`, so nothing made one, and there is nothing to stack on.
 *
 * The parent's own run is a root run by this test: its issue carries no parent
 * tag, so its pull request — the integration one, carrying every child's work —
 * targets the base branch like any other.
 */
export function stackedPrBase(repo: string): string | undefined {
  const issue = runIssueNumber();
  if (issue === undefined) return undefined;

  const parent = parentIssueOf(repo, issue);
  if (!parent) return undefined;

  const parentBranch = branchOfIssue(parent);
  const { code, stdout } = gitRun("ls-remote", "--heads", "origin", `refs/heads/${parentBranch}`);
  return code === 0 && stdout.trim() ? parentBranch : undefined;
}

/**
 * The issue this run is working on, or undefined when it is not an issue run.
 *
 * Both callers above need the same two conditions — the run is an issue run,
 * and the number is a real one — and both are wrong in the same way if either
 * is dropped: a pull request run's `ISSUE_NUMBER` is the pull request's number,
 * and treating it as an issue moves work off the branch under review.
 */
function runIssueNumber(): number | undefined {
  if (process.env.ATOMA_RUN_TYPE !== "issue") return undefined;
  const issue = Number((process.env.ISSUE_NUMBER ?? "").trim());
  return Number.isInteger(issue) && issue > 0 ? issue : undefined;
}

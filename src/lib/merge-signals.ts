/**
 * merge-signals.ts — reads GitHub's view of a pull request into the input
 * `domain/merge-readiness.ts` decides on.
 *
 * The adapter half of that pair: everything here is I/O and shape-mapping,
 * everything there is decision. Keeping them apart is what lets the whole merge
 * truth table be tested against plain objects with no `gh` in the loop, and it is
 * the same split `domain/handoff.ts` already uses.
 *
 * It lived inside mcp/github.ts, which had grown to 870 lines and was by then the
 * gh plumbing, the tool schemas, the tool handlers, the dispatch helpers AND this.
 * Three GitHub calls that exist only to feed one pure function do not belong in a
 * server's tool registry.
 */
import { gh } from "./gh.ts";
import { getGovernedPaths, getMergePolicy } from "./config.ts";
import { governedPathsIn, type MergeSignals } from "../domain/merge-readiness.ts";

export interface PullRequestRefs {
  headRefName: string;
  baseRefName: string;
}

interface PullRequestView {
  mergeStateStatus?: string;
  isDraft?: boolean;
  /** `is_bot` distinguishes an agent's pull request from a person's. */
  author?: { is_bot?: boolean };
  state?: string;
  headRefOid?: string;
  headRefName?: string;
  baseRefName?: string;
}

interface CheckRunsResponse {
  check_runs?: { name: string; status: string; conclusion: string | null; details_url?: string }[];
}

interface BranchRule {
  type: string;
  parameters?: { required_status_checks?: { context: string }[] };
}

function log(message: string): void {
  console.error(`[atoma-merge-signals] ${message}`);
}

/**
 * Status-check contexts the branch's protection requires.
 *
 * Best-effort by design. This only makes a refusal more specific — naming the
 * check to fix rather than relaying GitHub's verdict verbatim — so a transient 403
 * or rate limit must not become a tool error that loses the verdict altogether.
 * `decideMergeReadiness` degrades to its generic `blocked` blocker on an empty
 * list.
 *
 * Read from the repository rather than hardcoded, so editing
 * `.github/rulesets/*.json` changes what the gate enforces with no code change.
 */
function readRequiredChecks(repo: string, baseRef: string): string[] {
  if (!baseRef) return [];

  const { code, stdout } = gh("api", `repos/${repo}/rules/branches/${baseRef}`);
  if (code) {
    log(`WARN could not read branch rules for ${baseRef}; blockers will be less specific`);
    return [];
  }
  try {
    const rules = JSON.parse(stdout || "[]") as BranchRule[];
    return rules
      .filter((rule) => rule.type === "required_status_checks")
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((check) => check.context);
  } catch {
    log(`WARN branch rules for ${baseRef} were not valid JSON`);
    return [];
  }
}

/**
 * The files this pull request changes that govern how agents run.
 *
 * Fails CLOSED, unlike `readRequiredChecks` above: when the file list cannot be
 * read, this reports the pull request as touching governance so the merge falls
 * to a person. The two differ because of what each failure costs. An unreadable
 * rule list only makes a refusal less specific; an unreadable file list, treated
 * as empty, would let an agent merge exactly the change this exists to stop.
 */
function readGovernancePaths(repo: string, num: number): string[] {
  // `--jq` rather than parsing the response: with `--paginate` the pages arrive
  // as separate JSON documents, which `JSON.parse` cannot read, and dropping
  // `--paginate` would silently stop at 100 files — a large pull request could
  // then hide a workflow change on page two.
  const { code, stdout } = gh(
    "api", `repos/${repo}/pulls/${num}/files?per_page=100`, "--paginate", "--jq", ".[].filename",
  );
  if (code) {
    log(`WARN could not read changed files for #${num}; treating the merge as a person's`);
    return ["(could not read the changed files)"];
  }
  const files = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return governedPathsIn(files, getGovernedPaths());
}

/**
 * GitHub's view of one pull request, plus the check runs on its head commit.
 *
 * `throwOnFailure` is injected rather than imported so the caller keeps ownership
 * of how a hard failure surfaces — an MCP server turns it into a tool error.
 */
export function gatherMergeSignals(
  repo: string,
  num: number,
  throwOnFailure: (message: string) => never,
): { signals: MergeSignals; refs: PullRequestRefs } {
  const json = <T>(...args: string[]): T => {
    const { code, stdout, stderr } = gh(...args);
    if (code) throwOnFailure(stderr || stdout);
    return stdout ? (JSON.parse(stdout) as T) : (null as T);
  };

  const pr = json<PullRequestView>(
    "pr", "view", String(num), "--repo", repo,
    // `mergeable` is deliberately absent: `mergeStateStatus` is the verdict, and
    // requesting it is already what makes GitHub compute mergeability, so asking
    // for both only produced a field nothing read.
    //
    // `isDraft` is not that: it is an attribute of the pull request, not a second
    // opinion on mergeability. It is here because `mergeStateStatus` came back
    // `CLEAN` for a draft, so the verdict alone reported one as ready to merge.
    "--json", "mergeStateStatus,isDraft,author,state,headRefOid,headRefName,baseRefName",
  );

  // Check runs hang off the commit, so a `workflow_dispatch` run against the
  // branch registers here exactly as a `pull_request` run would. That is what
  // makes the reviewer's pre-merge CI dispatch visible to this gate at all.
  const sha = pr?.headRefOid ?? "";
  const runs = sha ? json<CheckRunsResponse>("api", `repos/${repo}/commits/${sha}/check-runs`) : null;

  const baseRefName = pr?.baseRefName ?? "";

  return {
    signals: {
      mergeStateStatus: pr?.mergeStateStatus ?? "UNKNOWN",
      isDraft: pr?.isDraft ?? false,
      // Defaults to treating the author as a person. If the field is missing the
      // safe reading is "do not merge this for someone", not "merge it".
      authoredByAgent: pr?.author?.is_bot ?? false,
      state: pr?.state ?? "UNKNOWN",
      checks: (runs?.check_runs ?? []).map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        ...(run.details_url ? { detailsUrl: run.details_url } : {}),
      })),
      requiredChecks: readRequiredChecks(repo, baseRefName),
      mergePolicy: getMergePolicy(),
      governancePaths: readGovernancePaths(repo, num),
    },
    refs: { headRefName: pr?.headRefName ?? "", baseRefName },
  };
}

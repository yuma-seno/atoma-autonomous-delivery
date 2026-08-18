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
import { readRequiredChecks } from "./branch-rules.ts";
import { getGovernedPaths, getMergeGates, getMergePolicy } from "./config.ts";
import { governedPathsIn, type MergeSignals } from "../domain/merge-readiness.ts";
import { pathPatternProblem } from "../domain/path-patterns.ts";
import {
  matchMergeGates,
  type ChangedFile,
  type FileStatus,
  type MergeGateMatch,
} from "../domain/merge-gates.ts";

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
  /** Both read only for `merge_gates` conditions; nothing else consults them. */
  title?: string;
  labels?: { name?: string }[];
}

interface CheckRunsResponse {
  check_runs?: { name: string; status: string; conclusion: string | null; details_url?: string }[];
}

function log(message: string): void {
  console.error(`[atoma-merge-signals] ${message}`);
}

/**
 * Why this project's `governed_paths` cannot be honoured as written.
 *
 * The same check `merge_gates` patterns get, on the gate that matters more.
 * `governed_paths` decides which changes to the agent's own limits fall to a
 * person, so a pattern that matches nothing hands the agent exactly what the
 * setting was written to withhold — and does it in silence.
 *
 * Reported through the same `gate-config-invalid` blocker as a bad `merge_gates`
 * entry, because it is the same sentence to the person reading it: a gate this
 * project declared could not be evaluated, so the merge is theirs.
 */
function governedPathProblems(): string[] {
  return getGovernedPaths()
    .map((pattern) => pathPatternProblem(pattern))
    .filter((problem) => problem !== "")
    .map((problem) => `\`governed_paths\`: ${problem}`);
}

/**
 * GitHub's per-file statuses, reduced to the three a gate can name.
 *
 * `copied` is an addition. `renamed` is an addition at the new path, and the
 * removal at the old one is added separately below. `changed` is GitHub's word
 * for a mode or type change, which is a modification.
 */
const STATUS_MAP: Record<string, FileStatus> = {
  added: "added",
  copied: "added",
  renamed: "added",
  removed: "removed",
  modified: "modified",
  changed: "modified",
};

/**
 * Statuses that are not a change at all.
 *
 * `unchanged` appears when GitHub lists a file whose content is identical to the
 * base. Mapping it to `modified` would fire a gate over a file nobody touched.
 */
const NOT_A_CHANGE = new Set(["unchanged"]);

interface ChangedFilesRead {
  readonly files: readonly ChangedFile[];
  /** Why the read cannot be trusted, or "" when it can. */
  readonly problem: string;
}

/**
 * What this pull request changes, and what happened to each file.
 *
 * Fails CLOSED, unlike `readRequiredChecks` in `branch-rules.ts`, and the two differ because of
 * what each failure costs. An unreadable rule list only makes a refusal less
 * specific; an unreadable file list, treated as empty, would let an agent merge
 * exactly the change the governance gate and every declared merge gate exist to
 * stop. So a failure here comes back as a problem, and a problem blocks.
 *
 * One read serves both gates. They ask different questions of the same list, and
 * two calls would be two chances for one of them to silently see nothing.
 */
function readChangedFiles(repo: string, num: number): ChangedFilesRead {
  // `--jq` rather than parsing the response: with `--paginate` the pages arrive
  // as separate JSON documents, which `JSON.parse` cannot read, and dropping
  // `--paginate` would silently stop at 100 files — a large pull request could
  // then hide a workflow change on page two.
  //
  // One JSON array per line rather than `@tsv`, because a tracked path may
  // legitimately contain a tab or a newline and `@tsv` renders both as escapes
  // that split into the wrong fields — a file whose name held a tab would arrive
  // as a status with no path, which `readChangedFiles` reports as unrecognised
  // and turns into a blocker on an honest pull request.
  //
  // `@json` escapes them inside the string, so one file stays one line and
  // `JSON.parse` gives the exact bytes back. `previous_filename` is absent on all
  // but a rename, hence the `//` default.
  const { code, stdout } = gh(
    "api",
    `repos/${repo}/pulls/${num}/files?per_page=100`,
    "--paginate",
    "--jq",
    '.[] | [.status, .filename, (.previous_filename // "")] | @json',
  );
  if (code) {
    log(`WARN could not read changed files for #${num}; treating the merge as a person's`);
    return { files: [], problem: `the changed files of #${num} could not be read` };
  }

  const files: ChangedFile[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let status = "";
    let path = "";
    let previous = "";
    try {
      [status, path, previous] = JSON.parse(line) as [string, string, string];
    } catch {
      // Fail closed, like every other unreadable answer here. A line this cannot
      // parse means the list is not the list, and guessing at the rest of it
      // would be guessing at which files a gate should have seen.
      return { files: [], problem: `the changed-file list of #${num} could not be parsed` };
    }
    if (NOT_A_CHANGE.has((status ?? "").trim())) continue;
    const mapped = STATUS_MAP[(status ?? "").trim()];
    if (!mapped || !path) {
      // Not a case to guess at. Treating an unrecognised status as "modified"
      // would let a `files_added` gate be walked past by whatever GitHub starts
      // calling an addition next, and the failure would be invisible.
      return {
        files: [],
        problem: `GitHub reported file status '${status}' for #${num}, which Atoma does not recognise`,
      };
    }
    // A rename is an addition at the new path and a removal at the old one. Read
    // as a bare "renamed" it would be neither, and `git mv` into a gated
    // directory would add a file no `files_added` gate could see.
    files.push({ path, status: mapped });
    if ((status ?? "").trim() === "renamed" && previous) {
      files.push({ path: previous, status: "removed" });
    }
  }
  return { files, problem: "" };
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
    //
    // `title` and `labels` are here for `merge_gates` only. They ride along on a
    // call already being made, so a project that declares no gate pays nothing
    // for the ones it could have declared.
    "--json",
    "mergeStateStatus,isDraft,author,state,headRefOid,headRefName,baseRefName,title,labels",
  );

  // Check runs hang off the commit, so a `workflow_dispatch` run against the
  // branch registers here exactly as a `pull_request` run would. That is what
  // makes the reviewer's pre-merge CI dispatch visible to this gate at all.
  const sha = pr?.headRefOid ?? "";
  const runs = sha ? json<CheckRunsResponse>("api", `repos/${repo}/commits/${sha}/check-runs`) : null;

  const baseRefName = pr?.baseRefName ?? "";

  // One read, two gates. A failure to read it is a problem rather than an empty
  // list, so both gates block instead of quietly finding nothing.
  const required = readRequiredChecks(repo, baseRefName);
  if (!required.known) log(`WARN ${required.why}; blockers will be less specific`);

  const changed = readChangedFiles(repo, num);
  const gates = getMergeGates();
  const gateProblems = [...gates.problems, ...governedPathProblems()];
  if (changed.problem) gateProblems.push(changed.problem);

  const gateMatches: MergeGateMatch[] = changed.problem
    ? []
    : [
        ...matchMergeGates(gates.gates, {
          changedFiles: changed.files,
          labels: (pr?.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
          title: pr?.title ?? "",
        }),
      ];

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
      // An unreadable rule list only costs specificity here: `mergeStateStatus`
      // is still GitHub's verdict, and `decideMergeReadiness` falls back to its
      // generic `blocked` blocker. So this is the one caller for which "unknown"
      // and "none required" lead to the same place, and it says so rather than
      // relying on a shared empty list to mean both.
      requiredChecks: required.known ? required.contexts : [],
      mergePolicy: getMergePolicy(),
      // The sentinel keeps the governance gate's own fail-closed behaviour: an
      // unreadable file list reports the pull request as touching governance, so
      // that blocker fires with a legible reason of its own rather than relying
      // on the gate problem below to do the blocking.
      governancePaths: changed.problem
        ? ["(could not read the changed files)"]
        : governedPathsIn(
            changed.files.map((file) => file.path),
            getGovernedPaths(),
          ),
      gateMatches,
      gateProblems,
    },
    refs: { headRefName: pr?.headRefName ?? "", baseRefName },
  };
}

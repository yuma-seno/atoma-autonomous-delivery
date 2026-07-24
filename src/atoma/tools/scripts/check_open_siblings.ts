#!/usr/bin/env bun
/**
 * Count open sub-issues (siblings) still linked to a parent issue.
 *
 * Called (as a same-directory sibling) by aggregate_sub_issues.ts /
 * dispatch_if_siblings_done.ts (via the `.github/scripts/` copy below) and
 * dispatch_orchestrator_if_ready.ts (this copy) to decide whether all
 * sub-tasks of an orchestrated parent issue are done before re-invoking the
 * orchestrator.
 *
 * Usage:
 *   check_open_siblings.ts --repo OWNER/REPO --parent N [--label LABEL] [--launched-label LABEL]
 *
 * Prints the number of still-open sibling issues to stdout.
 *
 * NOTE: this is Atoma's own copy. An independent, functionally-identical
 * copy also lives at `.github/scripts/check_open_siblings.ts`
 * (source-tracked in src/scripts/, called by the two workflow-invoked
 * scripts named above) -- deliberately duplicated rather than shared so
 * each of `.github/atoma/**` and `.github/scripts/**` stays a fully
 * self-contained tree with no cross-references between them.
 */
import { parseArgs } from "node:util";
import { gh } from "./lib/gh.ts";
import { getLabel } from "./lib/config.ts";
import type { GhIssueSummary } from "./lib/types.ts";

interface CheckOpenSiblingsArgs {
  repo: string;
  parent: string | number;
  label?: string;
  "launched-label"?: string;
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      parent: { type: "string" },
      label: { type: "string" },
      "launched-label": { type: "string" },
    },
  });

  if (!values.repo || !values.parent) {
    console.error("usage: check_open_siblings.ts --repo OWNER/REPO --parent N");
    process.exit(2);
  }

  const label = values.label || getLabel("sub_issue", "atoma/sub-issue");
  const launchedLabel = values["launched-label"] || getLabel("launched", "atoma/launched");

  // Only count siblings that have actually been dispatched (labeled "launched").
  // Sub-issues created but not yet launched (e.g. a later phase in a
  // dependency-ordered plan) must NOT block re-invocation of the orchestrator,
  // otherwise the count can never reach zero and the orchestrator would never
  // be re-invoked to launch the next phase.
  const { code, stdout, stderr } = gh(
    "issue", "list",
    "--repo", values.repo,
    "--state", "open",
    "--label", label,
    "--label", launchedLabel,
    "--search", `atoma:parent=#${values.parent} in:body`,
    "--json", "number",
  );

  if (code !== 0) {
    console.error(`check_open_siblings: gh issue list failed: ${stderr}`);
    process.exit(1);
  }

  const siblings = (stdout ? JSON.parse(stdout) : []) as GhIssueSummary[];
  console.log(siblings.length);
}

if (import.meta.main) main();

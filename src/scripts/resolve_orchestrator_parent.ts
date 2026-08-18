#!/usr/bin/env bun
/**
 * resolve_orchestrator_parent.ts — print a sub-issue's orchestrator parent, for
 * a workflow step that needs the number in bash.
 *
 * The rule itself is `lib/parent-issue.ts`. It used to be written out here as
 * well -- its own GraphQL query and its own body-tag read -- which made this the
 * only one of three call sites with the richer rule, for no reason anything
 * recorded. Both halves already existed in `lib/`.
 *
 * Usage: resolve_orchestrator_parent.ts --repo OWNER/REPO --sub N
 * Prints the resolved parent issue number, or nothing, to stdout.
 */
import { parseArgs } from "node:util";
import { parentIssueOf } from "../lib/parent-issue.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface ResolveOrchestratorParentArgs {
  repo: string;
  sub: string | number;
}

export const ref = defineScript<ResolveOrchestratorParentArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      sub: { type: "string" },
    },
  });

  if (!values.repo || !values.sub) {
    console.error("usage: resolve_orchestrator_parent.ts --repo OWNER/REPO --sub N");
    process.exit(2);
  }

  const found = parentIssueOf(values.repo, Number(values.sub));
  if (!found.known) {
    // Empty stdout, and a non-zero exit. The caller reads stdout to decide
    // whether there is a parent to aggregate, and "" is how "no parent" is
    // spelled -- so a failed read that printed "" would be indistinguishable
    // from a root issue, which is the whole class of defect this repository has
    // been working through.
    console.error(`::error::${found.why}`);
    process.exit(1);
  }

  if (found.parent) console.error(`sub-issue #${values.sub} -> parent #${found.parent}`);
  console.log(found.parent || "");
}

if (import.meta.main) main();

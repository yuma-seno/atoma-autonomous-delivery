#!/usr/bin/env bun
/**
 * resolve_orchestrator_parent.ts — Resolve a sub-issue's orchestrator
 * parent: prefer the official GitHub sub-issues GraphQL `parent` field;
 * fall back to the canonical `<!-- atoma:parent=N -->` metadata embedded by
 * issue creation when the GraphQL parent lookup is unavailable.
 *
 * Usage: resolve_orchestrator_parent.ts --repo OWNER/REPO --sub N
 * Prints the resolved parent issue number (possibly empty) to stdout.
 */
import { parseArgs } from "node:util";
import { gh, ghGraphql } from "../lib/gh.ts";
import { defineScript } from "./lib/script-ref.ts";
import { PARENT_TAG } from "../lib/tags.ts";

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
  const [owner, repoName] = values.repo.split("/", 2);

  try {
    const data = ghGraphql<{ repository: { issue: { parent: { number: number } | null } } }>(
      "query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){parent{number}}}}",
      { owner: owner!, repo: repoName!, num: Number(values.sub) },
    );
    const parent = data.repository.issue.parent?.number;
    if (parent) {
      console.error(`Resolved via GraphQL parent: sub-issue #${values.sub} → parent #${parent}`);
      console.log(parent);
      return;
    }
  } catch {
    // fall through to body-comment fallback
  }

  const { code, stdout } = gh("issue", "view", String(values.sub), "--repo", values.repo, "--json", "body", "--jq", ".body");
  const body = code === 0 ? stdout : "";
  const parent = PARENT_TAG.read(body);
  if (parent) console.error(`Resolved via fallback: sub-issue #${values.sub} → parent #${parent}`);
  console.log(parent ?? "");
}

if (import.meta.main) main();

#!/usr/bin/env bun
/**
 * dispatch_if_siblings_done.ts — FALLBACK path for a manually-closed
 * sub-issue: if no open siblings remain, dispatch the orchestrator.
 *
 * Thin CLI wrapper around lib/aggregation.ts's shared dispatch gate -- see that
 * module's doc comment for the other two callers of the same gate (the PR-merge
 * primary path, and the MCP server's own post-close check) and for the race
 * between them.
 *
 * Usage: dispatch_if_siblings_done.ts --repo OWNER/REPO --parent N --closed-num N
 */
import { parseArgs } from "node:util";
import { defineScript } from "./lib/script-ref.ts";
import { dispatchOrchestratorIfReady } from "../lib/aggregation.ts";

export interface DispatchIfSiblingsDoneArgs {
  repo: string;
  parent: string | number;
  "closed-num": string | number;
}

export const ref = defineScript<DispatchIfSiblingsDoneArgs>(import.meta.url);

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      parent: { type: "string" },
      "closed-num": { type: "string" },
    },
  });
  if (!values.repo || !values.parent || !values["closed-num"]) {
    console.error("usage: dispatch_if_siblings_done.ts --repo OWNER/REPO --parent N --closed-num N");
    process.exit(2);
  }
  const { repo, parent } = values;
  const closedNum = values["closed-num"];

  console.log("Sub-issue closed manually. Checking open siblings...");

  const result = await dispatchOrchestratorIfReady({
    repo,
    parent: Number(parent),
    closedNum: Number(closedNum),
  });

  if (!result.ready) {
    console.log(`Still ${result.remaining} sibling(s) open. No action needed.`);
  } else if (!result.dispatched) {
    console.log(
      `Orchestrator was not dispatched for #${closedNum}: another caller already handled this ` +
        `completion, or the dispatch failed -- check for a WARN above.`,
    );
  } else {
    console.log(`All siblings done. Dispatched orchestrator on parent #${parent}.`);
  }
}

if (import.meta.main) void main();


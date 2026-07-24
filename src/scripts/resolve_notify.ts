#!/usr/bin/env bun
/**
 * resolve_notify.ts — Thin CLI wrapper around lib/notify.ts's
 * resolveNotify(), invoked as a workflow step (via `scriptCommand` from
 * atoma-runner.wac.ts, as a fallback when `inputs.notify` arrives empty).
 * Every other caller (mcp/github.ts, request_close_issue.ts,
 * lib/aggregation.ts) imports resolveNotify() directly -- see that
 * module's doc comment for the full resolution algorithm.
 *
 * Usage:
 *   resolve_notify.ts --repo OWNER/REPO --number N
 *
 * Prints the resolved login (possibly empty) to stdout.
 */
import { parseArgs } from "node:util";
import { defineScript } from "./lib/script-ref.ts";
import { resolveNotify } from "../lib/notify.ts";

/** CLI contract for this script, used by callers (e.g. src/workflows/*.wac.ts) to build a type-checked argv. */
export interface ResolveNotifyArgs {
  repo: string;
  number: string | number;
}

export const ref = defineScript<ResolveNotifyArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      number: { type: "string" },
    },
  });

  if (!values.repo || !values.number) {
    console.error("usage: resolve_notify.ts --repo OWNER/REPO --number N");
    process.exit(2);
  }

  console.log(resolveNotify(values.repo, Number(values.number)));
}

if (import.meta.main) main();


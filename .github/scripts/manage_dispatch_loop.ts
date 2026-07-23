#!/usr/bin/env bun
/**
 * manage_dispatch_loop.ts — Track the auto-dispatch loop counter in
 * session.json to prevent infinite agent handoff loops.
 *
 * Usage:
 *   manage_dispatch_loop.ts --session session.json
 *     [--new-event-count N] [--directive NAME]
 * Writes `auto_dispatch_count=N` and `loop_limit_reached=true|false` to
 * $GITHUB_OUTPUT.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defineScript } from "./lib/script-ref.ts";

export interface ManageDispatchLoopArgs {
  session: string;
  "new-event-count"?: string | number;
  directive?: string;
}

export const ref = defineScript<ManageDispatchLoopArgs>(import.meta.url);

const LOOP_LIMIT = 5;

interface Session {
  metadata?: { github_context?: { auto_dispatch_count?: number } };
  [key: string]: unknown;
}

export function manageDispatchLoop(
  session: Session,
  newEventCount: number,
  directive: string,
): { session: Session; autoDispatchCount: number; loopLimitReached: boolean } {
  const metadata = typeof session.metadata === "object" && session.metadata !== null ? session.metadata : {};
  const githubContext =
    typeof metadata.github_context === "object" && metadata.github_context !== null ? metadata.github_context : {};

  let autoDispatchCount: number;
  if (newEventCount !== 0) {
    autoDispatchCount = 0;
  } else {
    autoDispatchCount = Number(githubContext.auto_dispatch_count ?? 0);
    if (directive) autoDispatchCount += 1;
  }

  const loopLimitReached = autoDispatchCount >= LOOP_LIMIT;

  githubContext.auto_dispatch_count = autoDispatchCount;
  metadata.github_context = githubContext;
  session.metadata = metadata;

  return { session, autoDispatchCount, loopLimitReached };
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      session: { type: "string" },
      "new-event-count": { type: "string" },
      directive: { type: "string" },
    },
  });
  if (!values.session) {
    console.error("usage: manage_dispatch_loop.ts --session session.json [--new-event-count N] [--directive NAME]");
    process.exit(2);
  }

  const session = JSON.parse(readFileSync(values.session, "utf8")) as Session;
  const {
    session: updated,
    autoDispatchCount,
    loopLimitReached,
  } = manageDispatchLoop(session, Number(values["new-event-count"] ?? 0), values.directive ?? "");

  writeFileSync(values.session, JSON.stringify(updated, null, 2) + "\n");

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `auto_dispatch_count=${autoDispatchCount}\nloop_limit_reached=${loopLimitReached}\n`);
  }
  console.error(`Auto-dispatch loop count: ${autoDispatchCount}/${LOOP_LIMIT} (limit_reached=${loopLimitReached})`);
}

if (import.meta.main) main();

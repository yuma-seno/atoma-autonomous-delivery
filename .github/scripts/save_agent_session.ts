#!/usr/bin/env bun
/**
 * save_agent_session.ts — Save session.json to the atoma-data branch (via
 * lib/atoma-data.ts's saveSession(), which handles push-race retries using
 * an isolated git worktree).
 *
 * Usage: save_agent_session.ts --session session.json --type issue|pr --number N --agent NAME
 * No-ops quietly if --session doesn't exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { saveSession, sessionTargetPath } from "./lib/atoma-data.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface SaveAgentSessionArgs {
  session: string;
  type: string;
  number: string | number;
  agent: string;
}

export const ref = defineScript<SaveAgentSessionArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      session: { type: "string" },
      type: { type: "string" },
      number: { type: "string" },
      agent: { type: "string" },
    },
  });
  if (!values.session || !values.type || !values.number || !values.agent) {
    console.error("usage: save_agent_session.ts --session FILE --type issue|pr --number N --agent NAME");
    process.exit(2);
  }
  if (!existsSync(values.session)) {
    console.error("No session.json found, skipping save.");
    return;
  }

  const target = sessionTargetPath(values.type, values.number, values.agent);
  const content = readFileSync(values.session, "utf8");
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const saved = saveSession(target, content, `session: ${values.agent} on ${values.type} ${values.number} (run ${runId})`);
  if (!saved) {
    console.log(`::warning::Failed to save session to atoma-data:${target} after all retries.`);
  } else {
    console.error(`Session saved to atoma-data:${target}`);
  }
}

if (import.meta.main) main();

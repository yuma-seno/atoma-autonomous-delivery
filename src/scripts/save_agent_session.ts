#!/usr/bin/env bun
/**
 * save_agent_session.ts — Save session.json to the atoma-data branch (via
 * lib/atoma-data.ts's saveSession(), which handles push-race retries using
 * an isolated git worktree).
 *
 * Caps each tool result on the way out, so a session never grows past what a model
 * will accept in the first place. See `domain/session-size.ts` for the measurement
 * behind the number and for why this is the cheaper of the two places to do it.
 *
 * Usage: save_agent_session.ts --session session.json --type issue|pr --number N --agent NAME
 * No-ops quietly if --session doesn't exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { saveSession, sessionTargetPath } from "./lib/atoma-data.ts";
import { capToolResults, shrinkLogLine } from "../domain/session-size.ts";
import type { Session } from "../lib/session.ts";
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
  const content = capped(readFileSync(values.session, "utf8"));
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const saved = saveSession(target, content, `session: ${values.agent} on ${values.type} ${values.number} (run ${runId})`);
  if (!saved) {
    console.log(`::warning::Failed to save session to atoma-data:${target} after all retries.`);
  } else {
    console.error(`Session saved to atoma-data:${target}`);
  }
}

/**
 * The session with its oversized tool results shortened, or unchanged.
 *
 * Unreadable JSON is saved as it is rather than refused. This script's job is to get
 * the session onto the branch; a session that cannot be parsed is a problem for
 * whatever reads it next, and losing it here would be worse than storing it whole.
 */
function capped(content: string): string {
  let session: Session;
  try {
    session = JSON.parse(content) as Session;
  } catch {
    console.error("Could not read the session as JSON; saving it unchanged.");
    return content;
  }

  const result = capToolResults(session);
  const line = shrinkLogLine(result, "oversized tool results shortened");
  if (line !== undefined) console.error(line);
  return result.shrunk ? JSON.stringify(result.session, null, 2) : content;
}

if (import.meta.main) main();

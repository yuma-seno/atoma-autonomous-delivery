#!/usr/bin/env bun
/**
 * restore_agent_session.ts — Restore a per-agent session.json from the
 * `atoma-data` branch (if one exists yet for this type/number/agent),
 * without disturbing the current checkout.
 *
 * Usage: restore_agent_session.ts --type issue|pr --number N --agent NAME --out session.json
 * No-ops quietly (does not create --out) if no prior session is found.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { archiveSession, restoreSession, sessionTargetPath } from "./lib/atoma-data.ts";
import { defineScript } from "./lib/script-ref.ts";
import { shrinkIfNeeded, shrinkLogLine, stillTooBigLine } from "../domain/session-size.ts";
import type { Session } from "../lib/session.ts";

export interface RestoreAgentSessionArgs {
  type: string;
  number: string | number;
  agent: string;
  out: string;
  "session-mode"?: string;
}

export const ref = defineScript<RestoreAgentSessionArgs>(import.meta.url);

export interface RestoredAgentSession {
  target: string;
  content?: string;
}

export function findAgentSession(
  type: string,
  number: string | number,
  agent: string,
  load: (target: string) => string | undefined = restoreSession,
): RestoredAgentSession {
  const target = sessionTargetPath(type, number, agent);
  return { target, content: load(target) };
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: "string" },
      number: { type: "string" },
      agent: { type: "string" },
      out: { type: "string" },
      "session-mode": { type: "string" },
    },
  });
  if (!values.type || !values.number || !values.agent || !values.out) {
    console.error("usage: restore_agent_session.ts --type issue|pr --number N --agent NAME --out session.json");
    process.exit(2);
  }

  const { target, content } = findAgentSession(
    values.type,
    values.number,
    values.agent,
  );
  if (values["session-mode"] === "recover") {
    if (content === undefined) {
      console.error(`No existing session at ${target}; recovery will start fresh without an archive.`);
      return;
    }
    const archivedPath = archiveSession(values.type, values.number, values.agent, content);
    if (!archivedPath) throw new Error(`Failed to archive existing session before recovery: ${target}`);
    console.error(`Archived session to atoma-data:${archivedPath}; starting fresh.`);
    return;
  }
  if (content !== undefined) {
    writeFileSync(values.out, sized(content, target));
    console.error(`Restored session: ${target}`);
  } else {
    console.error(`No existing session at ${target}, starting fresh.`);
  }
}

/**
 * The restored session, shrunk if it has grown past what a model will accept.
 *
 * Here rather than in the core, because it needs no core change and because this
 * is the moment the history becomes this run's problem. See
 * `domain/session-size.ts` for what is dropped and why that is the right thing to
 * drop.
 *
 * Unreadable JSON is written back untouched rather than refused: whatever it is,
 * this script's job is to put the previous session in front of the run, and atoma
 * will report a malformed one better than a size check can.
 */
function sized(content: string, target: string): string {
  let session: Session;
  try {
    session = JSON.parse(content) as Session;
  } catch {
    console.error(`Could not read ${target} as JSON; restoring it unchanged.`);
    return content;
  }

  const result = shrinkIfNeeded(session);
  const shrank = shrinkLogLine(result);
  if (shrank !== undefined) console.error(shrank);
  // Said after the shrink, because it is only knowable then: a session that is
  // still too big has nothing left but conversation.
  const stuck = stillTooBigLine(result);
  if (stuck !== undefined) console.error(stuck);

  if (shrank === undefined) return content;
  return JSON.stringify(result.session, null, 2);
}

if (import.meta.main) main();

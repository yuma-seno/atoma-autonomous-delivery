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
import { restoreSession, sessionTargetPath } from "./lib/atoma-data.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface RestoreAgentSessionArgs {
  type: string;
  number: string | number;
  agent: string;
  out: string;
}

export const ref = defineScript<RestoreAgentSessionArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: "string" },
      number: { type: "string" },
      agent: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.type || !values.number || !values.agent || !values.out) {
    console.error("usage: restore_agent_session.ts --type issue|pr --number N --agent NAME --out session.json");
    process.exit(2);
  }

  const target = sessionTargetPath(values.type, values.number, values.agent);
  const content = restoreSession(target);
  if (content !== undefined) {
    writeFileSync(values.out, content);
    console.error(`Restored session: ${target}`);
  } else {
    console.error(`No existing session at ${target}, starting fresh.`);
  }
}

if (import.meta.main) main();

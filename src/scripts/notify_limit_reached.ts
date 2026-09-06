#!/usr/bin/env bun
/**
 * notify_limit_reached.ts — Post a "the run reached its limit" comment on an
 * issue/PR, mentioning the notify login when known.
 *
 * Usage: notify_limit_reached.ts --number N --agent AGENT [--notify LOGIN]
 */
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gh } from "../lib/gh.ts";
import { LLM_CONTEXT_TAG } from "../lib/tags.ts";
import { toolCallTally } from "../domain/tool-tally.ts";
import type { Session } from "../lib/session.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface NotifyLimitReachedArgs {
  number: string | number;
  agent: string;
  notify?: string;
  /** The session, read to say what the run spent its budget on. */
  session?: string;
}

export const ref = defineScript<NotifyLimitReachedArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      agent: { type: "string" },
      notify: { type: "string" },
      session: { type: "string" },
    },
  });

  if (!values.number || !values.agent) {
    console.error("usage: notify_limit_reached.ts --number N --agent AGENT [--notify LOGIN]");
    process.exit(2);
  }

  // Tagged out of the model's context. This is addressed to a person -- it names
  // one, and asks them to retry -- and the next run can do nothing with it but
  // carry it.
  //
  // Carrying it is not free. Measured on #492: three failed runs left a session of
  // 425 messages, and the fourth spent 348k prompt tokens over four iterations and
  // then gave up without following its instructions. The same instructions on a
  // fresh issue took 61k and completed. Failure notices are part of what filled
  // that up, and the direction is the wrong one -- failing makes the context
  // heavier, and a heavier context fails more.
  const notice = values.notify
    ? `@${values.notify} Atoma: \`${values.agent}\` ran out of time. Review the issue and comment \`/${values.agent}\` to retry.`
    : `Atoma: \`${values.agent}\` ran out of time. Comment \`/${values.agent}\` to retry.`;

  // What it spent it on, so a person can tell a run that was going round from one
  // that was making progress -- without opening the workflow log or the session.
  //
  // No model call and no report. #544 asked for one and the data said no: these
  // agents write nothing until their final turn, so a run cut off before it has
  // nothing to say, and the session survives for a retry anyway. What a person
  // actually needs here is whether to retry or to re-scope, and a tally answers that.
  const spent = toolCallTally(readSession(values.session));

  gh(
    "issue",
    "comment",
    values.number,
    "--body",
    [`${LLM_CONTEXT_TAG.write("exclude")}`, notice, ...(spent ? ["", spent] : [])].join("\n"),
  );
}

/**
 * The session, or nothing.
 *
 * Every failure here is silent on purpose: the notice is the thing that matters and
 * it must go out. A tally is an improvement to it, not a precondition for it.
 */
function readSession(path: string | undefined): Session | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Session;
  } catch {
    return undefined;
  }
}

if (import.meta.main) main();

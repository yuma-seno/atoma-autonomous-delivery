#!/usr/bin/env bun
/**
 * notify_max_iterations.ts — Post a "max iterations reached" comment on an
 * issue/PR, mentioning the notify login when known.
 *
 * Usage: notify_max_iterations.ts --number N --agent AGENT [--notify LOGIN]
 */
import { parseArgs } from "node:util";
import { gh } from "../lib/gh.ts";
import { LLM_CONTEXT_TAG } from "../lib/tags.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface NotifyMaxIterationsArgs {
  number: string | number;
  agent: string;
  notify?: string;
}

export const ref = defineScript<NotifyMaxIterationsArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      number: { type: "string" },
      agent: { type: "string" },
      notify: { type: "string" },
    },
  });

  if (!values.number || !values.agent) {
    console.error("usage: notify_max_iterations.ts --number N --agent AGENT [--notify LOGIN]");
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
    ? `@${values.notify} Atoma: \`${values.agent}\` reached the max iteration limit. Review the issue and comment \`/${values.agent}\` to retry.`
    : `Atoma: \`${values.agent}\` reached the max iteration limit. Comment \`/${values.agent}\` to retry.`;

  gh("issue", "comment", values.number, "--body", `${LLM_CONTEXT_TAG.write("exclude")}\n${notice}`);
}

if (import.meta.main) main();

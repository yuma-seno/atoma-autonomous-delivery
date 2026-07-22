#!/usr/bin/env bun
/**
 * notify_max_iterations.ts — Post a "max iterations reached" comment on an
 * issue/PR, mentioning the notify login when known.
 *
 * Usage: notify_max_iterations.ts --number N --agent AGENT [--notify LOGIN]
 */
import { parseArgs } from "node:util";
import { gh } from "./lib/gh.ts";
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

  const body = values.notify
    ? `@${values.notify} Atoma: \`${values.agent}\` reached the max iteration limit. Review the issue and comment \`/${values.agent}\` to retry.`
    : `Atoma: \`${values.agent}\` reached the max iteration limit. Comment \`/${values.agent}\` to retry.`;

  gh("issue", "comment", values.number, "--body", body);
}

if (import.meta.main) main();

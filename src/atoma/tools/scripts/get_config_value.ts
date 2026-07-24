#!/usr/bin/env bun
/**
 * Print a dotted-path value from .github/atoma/config.json.
 *
 * Usage:
 *   bun run get_config_value.ts <dotted.path> [default]
 *
 * Examples:
 *   bun run get_config_value.ts agents.engineer.max_iterations 30
 *   bun run get_config_value.ts labels.in_progress atoma/in-progress
 *
 * NOTE: this is Atoma's own copy (called by launch_sub_agent.ts, a
 * same-directory sibling). An independent, functionally-identical copy also
 * lives at `.github/scripts/get_config_value.ts` (source-tracked in
 * src/scripts/, called by atoma-runner.wac.ts) -- deliberately duplicated
 * rather than shared so each of `.github/atoma/**` and `.github/scripts/**`
 * stays a fully self-contained tree with no cross-references between them.
 */
import { loadConfig } from "./lib/config.ts";

function main(): void {
  const [path, fallback = ""] = Bun.argv.slice(2);
  if (!path) {
    console.error("usage: get_config_value.ts <dotted.path> [default]");
    process.exit(2);
  }

  let node: unknown = loadConfig();
  for (const key of path.split(".")) {
    if (node && typeof node === "object" && key in node) {
      node = (node as Record<string, unknown>)[key];
    } else {
      console.log(fallback);
      return;
    }
  }
  console.log(node);
}

if (import.meta.main) main();

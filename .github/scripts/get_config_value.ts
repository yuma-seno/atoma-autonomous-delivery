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
 */
import { loadConfig } from "./lib/config.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

/** Build the positional argv for this script, used by callers for a type-checked invocation. */
export function buildArgv(path: string, fallback?: string): string[] {
  return fallback === undefined ? [`"${path}"`] : [`"${path}"`, `"${fallback}"`];
}

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

#!/usr/bin/env bun
/**
 * manage_in_progress_label.ts — Add or remove the config.json-configured
 * "in_progress" label on an issue/PR (works for PR numbers too, since
 * GitHub treats every PR as an issue under the hood). Best-effort: never
 * fails the calling step, only logs a warning (matching the previous
 * `2>/dev/null || true` bash behavior).
 *
 * Usage: manage_in_progress_label.ts --action add|remove --number N
 */
import { parseArgs } from "node:util";
import { gh } from "./lib/gh.ts";
import { getLabel } from "./lib/config.ts";

export interface ManageInProgressLabelArgs {
  action: "add" | "remove";
  number: string | number;
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      action: { type: "string" },
      number: { type: "string" },
    },
  });

  if (values.action !== "add" && values.action !== "remove") {
    console.error("usage: manage_in_progress_label.ts --action add|remove --number N");
    process.exit(2);
  }
  if (!values.number) {
    console.error("usage: manage_in_progress_label.ts --action add|remove --number N");
    process.exit(2);
  }

  const label = getLabel("in_progress", "atoma/in-progress");

  if (values.action === "add") {
    // Create the label if it does not exist yet.
    gh("label", "create", label, "--force", "-c", "0366d6", "-d", "Issue is being worked on by an Atoma agent");
    const { code } = gh("issue", "edit", values.number, "--add-label", label);
    if (code !== 0) console.error(`Warning: failed to add '${label}' label to #${values.number}`);
  } else {
    const { code } = gh("issue", "edit", values.number, "--remove-label", label);
    if (code !== 0) console.error(`Warning: failed to remove '${label}' label from #${values.number}`);
  }
}

if (import.meta.main) main();

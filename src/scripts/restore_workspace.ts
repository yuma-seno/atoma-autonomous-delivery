#!/usr/bin/env bun
/**
 * restore_workspace.ts — put back the working files this issue's agents left last
 * run.
 *
 * Runs before the agent. A first run for an issue restores nothing, which is the
 * ordinary case and not a failure: the directory is created either way, so the
 * agent finds an empty one rather than a missing one. Those are different things to
 * a model reading a tool result, and only one of them invites a retry.
 *
 * Usage:
 *   restore_workspace.ts --type issue|pr --number N --dest /tmp/atoma-workspace
 *     [--repo owner/name]
 *
 * Writes `root_issue` and `restored` to $GITHUB_OUTPUT so the save step at the end
 * of the run writes back to the same place without resolving the chain twice --
 * a second resolution could disagree with the first if a parent tag changed
 * mid-run, and then the run would read from one workspace and write to another.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { restoreWorkspace, workspaceTargetPrefix } from "./lib/atoma-data.ts";
import { resolveWorkspaceScope } from "../lib/workspace-scope.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface RestoreWorkspaceArgs {
  type: string;
  number: string | number;
  dest: string;
  repo?: string;
}

export const ref = defineScript<RestoreWorkspaceArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: "string" },
      number: { type: "string" },
      dest: { type: "string" },
      repo: { type: "string" },
    },
  });

  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!values.type || !values.number || !values.dest || !repo) {
    console.error("usage: restore_workspace.ts --type issue|pr --number N --dest PATH [--repo owner/name]");
    process.exit(2);
  }

  const scope = resolveWorkspaceScope(repo, values.type, values.number);
  const prefix = workspaceTargetPrefix(scope.rootIssue);

  // Created before the restore attempt, and kept even when there is nothing to
  // restore. The agent is told this path exists; a missing directory would make
  // that sentence false on every first run.
  mkdirSync(values.dest, { recursive: true });
  const restored = restoreWorkspace(prefix, values.dest);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `root_issue=${scope.rootIssue}\nrestored=${restored}\n`);
  }
  console.error(
    restored
      ? `[atoma-workspace] restored ${prefix} into ${values.dest}`
      : `[atoma-workspace] nothing stored at ${prefix} yet; ${values.dest} starts empty`,
  );
}

if (import.meta.main) main();

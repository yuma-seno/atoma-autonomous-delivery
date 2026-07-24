#!/usr/bin/env bun
/**
 * launch_sub_agent.ts
 *
 * Directly dispatches an Atoma agent on a sub-issue via gh workflow run.
 * Called by mcp/atoma.ts when the orchestrator uses launch_sub_agent.
 *
 * Usage: launch_sub_agent.ts --issue N --agent AGENT_NAME
 */
import { parseArgs } from "node:util";
import { gh } from "./lib/gh.ts";

/** CLI contract for this script, used by callers to build a type-checked argv. */
export interface LaunchSubAgentArgs {
  issue: string | number;
  agent: string;
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      agent: { type: "string" },
    },
  });

  const issue = values.issue ?? "";
  const agent = values.agent ?? "";

  if (!issue) {
    console.error("Error: --issue is required");
    process.exit(1);
  }
  if (!agent) {
    console.error("Error: --agent is required");
    process.exit(1);
  }
  if (!/^\d+$/.test(issue)) {
    console.error(`Error: --issue must be a positive integer, got: ${issue}`);
    process.exit(1);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) {
    console.error(`Error: --agent must be a valid lowercase agent name, got: ${agent}`);
    process.exit(1);
  }

  console.error(`Dispatching agent '${agent}' on sub-issue #${issue} ...`);

  gh("issue", "comment", issue, "--body", `Atoma: Agent \`${agent}\` dispatched to work on this sub-task.`);

  // Mark this sub-issue as launched so aggregation gating (check_open_siblings.ts)
  // only waits on sub-issues that have actually been dispatched, not ones still
  // pending a later phase (see docs/agent-definition.md dependency handling).
  const configOut = Bun.spawnSync({
    cmd: ["bun", "run", ".github/atoma/tools/scripts/get_config_value.ts", "labels.launched", "atoma/launched"],
    stdout: "pipe",
  });
  const launchedLabel = configOut.stdout.toString("utf8").trim();
  const { code: labelCode } = gh("issue", "edit", issue, "--add-label", launchedLabel);
  if (labelCode !== 0) {
    console.error(`Warning: failed to add '${launchedLabel}' label to #${issue}`);
  }

  const dispatchWorkflow = process.env.ATOMA_DISPATCH_WORKFLOW || "atoma-runner.yml";
  gh(
    "workflow", "run", dispatchWorkflow,
    "--field", `agent=${agent}`,
    "--field", `number=${issue}`,
    "--field", "type=issue",
    "--field", `notify=${process.env.ISSUE_NOTIFY ?? ""}`,
  );

  console.log(`dispatched: agent=${agent} issue=#${issue}`);
}

if (import.meta.main) main();

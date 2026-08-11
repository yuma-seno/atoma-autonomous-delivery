#!/usr/bin/env bun
/**
 * resolve_entry_agent.ts — Parse the "/agent-name" slash command from the
 * first non-blank line of a newly-opened issue's body, and emit
 * agent/number/type/notify as step outputs for atoma-entry.wac.ts.
 *
 * Env: NUMBER, SENDER (issue number + the user who opened it), GITHUB_EVENT_PATH
 * Writes to $GITHUB_OUTPUT: agent, number, type, notify -- only if a valid
 * slash command was found on the first line; otherwise writes nothing, so a
 * downstream `if: steps.resolve.outputs.agent != ''` naturally stays false.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { isAgentName } from "../lib/agent-name.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

interface GithubIssueOpenedEvent {
  issue?: { body?: string };
}

function main(): void {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const number = process.env.NUMBER ?? "";
  const sender = process.env.SENDER ?? "";
  const githubOutput = process.env.GITHUB_OUTPUT;

  if (!eventPath) {
    console.error("resolve_entry_agent: GITHUB_EVENT_PATH is not set");
    return;
  }

  const event = JSON.parse(readFileSync(eventPath, "utf8")) as GithubIssueOpenedEvent;
  const body = event.issue?.body ?? "";
  const firstLine = (body.trim().split("\n")[0] ?? "").trim();

  if (!firstLine.startsWith("/")) return;
  const agent = firstLine.slice(1).trim();
  if (!agent) return;

  // The name is spliced into shell text downstream (`AGENT="${{ inputs.agent }}"`
  // in atoma-runner) and into an agent-definition path, so anything that is not
  // a bare name stops here. Emitting no output leaves the caller's
  // `if: steps.resolve.outputs.agent != ''` false, which is the same no-op as an
  // issue that opened with no slash command at all.
  //
  // A warning rather than silence because the two realistic causes are a typo
  // and the documented-elsewhere habit of writing instructions on the command
  // line: `/engineer implement X` reads as valid to a human and is not.
  if (!isAgentName(agent)) {
    console.error(
      `::warning::Ignoring '/${agent}': an agent command must be a bare name on its own line ` +
        `(for example '/engineer'), with any instructions on the lines after it.`,
    );
    return;
  }

  if (githubOutput) {
    appendFileSync(githubOutput, [`agent=${agent}`, `number=${number}`, "type=issue", `notify=${sender}`].join("\n") + "\n");
  }
}

if (import.meta.main) main();

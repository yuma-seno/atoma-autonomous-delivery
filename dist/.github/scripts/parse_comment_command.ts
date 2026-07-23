#!/usr/bin/env bun
/**
 * parse_comment_command.ts — Parse a GitHub comment and extract a
 * slash-command agent name from any line, not just the first.
 *
 * Accepts both a plain slash command (`/engineer fix it`) and the internal
 * dispatch-comment format (`<!-- atoma:dispatch=engineer -->`) posted by
 * other automation.
 *
 * Env: ATOMA_COMMENT_BODY
 * Writes `matched=true|false` and `agent=<name-or-empty>` to $GITHUB_OUTPUT.
 */
import { appendFileSync } from "node:fs";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

const COMMAND_RE = /^\/([a-z][a-z0-9-]*)/;
const DISPATCH_RE = /^<!--\s*atoma:dispatch\s*=\s*([a-z][a-z0-9-]*)\s*-->/;

export function parseAgent(body: string): string {
  if (!body) return "";
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const commandMatch = COMMAND_RE.exec(line);
    if (commandMatch) return commandMatch[1]!;
    const dispatchMatch = DISPATCH_RE.exec(line);
    if (dispatchMatch) return dispatchMatch[1]!;
  }
  return "";
}

function main(): void {
  const body = process.env.ATOMA_COMMENT_BODY ?? "";
  const agent = parseAgent(body);
  const matched = agent ? "true" : "false";

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `matched=${matched}\nagent=${agent}\n`);
  }
}

if (import.meta.main) main();

#!/usr/bin/env bun
/**
 * parse_comment_command.ts — Parse a GitHub comment and extract a
 * slash-command agent name and optional session mode from any line.
 *
 * Human commands must occupy their own line: `/engineer` or
 * `/engineer recover`. Instructions belong on following lines. Internal
 * dispatch comments remain accepted for automation.
 *
 * Env: ATOMA_COMMENT_BODY
 * Writes `matched`, `agent`, `session_mode`, and `error` to $GITHUB_OUTPUT.
 */
import { appendFileSync } from "node:fs";
import { AGENT_NAME_PATTERN } from "../lib/agent-name.ts";
import { defineScript } from "./lib/script-ref.ts";

export const ref = defineScript(import.meta.url);

const COMMAND_RE = new RegExp(`^\\/(${AGENT_NAME_PATTERN})(?:\\s+(.*))?$`);
// Deliberately NOT `DISPATCH_TAG.read` from lib/tags.ts, and the difference is
// load-bearing: this must be anchored to the start of a line so a dispatch
// marker quoted inside a human's comment cannot trigger a run, whereas
// `DISPATCH_TAG` matches anywhere in a body by design. The whitespace
// tolerance around `=` is likewise wider than the tag writer ever emits --
// it costs nothing and this is the one place reading a marker a human may
// have retyped by hand.
const DISPATCH_RE = new RegExp(`^<!--\\s*atoma:dispatch\\s*=\\s*(${AGENT_NAME_PATTERN})\\s*-->`);

export interface ParsedCommentCommand {
  agent: string;
  sessionMode: "continue" | "recover";
  error: string;
}

export function parseCommentCommand(body: string): ParsedCommentCommand {
  if (!body) return { agent: "", sessionMode: "continue", error: "" };
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const commandMatch = COMMAND_RE.exec(line);
    if (commandMatch) {
      const agent = commandMatch[1]!;
      const modifier = commandMatch[2]?.trim() ?? "";
      if (!modifier) return { agent, sessionMode: "continue", error: "" };
      if (modifier === "recover") return { agent, sessionMode: "recover", error: "" };
      return {
        agent: "",
        sessionMode: "continue",
        error: `Unknown command syntax: '/${agent} ${modifier}'. Put instructions on the lines after '/${agent}', or use '/${agent} recover'.`,
      };
    }
    const dispatchMatch = DISPATCH_RE.exec(line);
    if (dispatchMatch) return { agent: dispatchMatch[1]!, sessionMode: "continue", error: "" };
  }
  return { agent: "", sessionMode: "continue", error: "" };
}

function main(): void {
  const body = process.env.ATOMA_COMMENT_BODY ?? "";
  const { agent, sessionMode, error } = parseCommentCommand(body);
  const matched = agent ? "true" : "false";

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `matched=${matched}\nagent=${agent}\n`);
    appendFileSync(githubOutput, `session_mode=${sessionMode}\nerror=${error}\n`);
  }
}

if (import.meta.main) main();

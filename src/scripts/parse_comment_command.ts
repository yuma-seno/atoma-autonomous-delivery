#!/usr/bin/env bun
/**
 * parse_comment_command.ts — Parse a GitHub comment and extract either a
 * slash-command agent name and optional session mode, or a control command, from
 * any line.
 *
 * Human commands must occupy their own line: `/engineer` or
 * `/engineer recover`. Instructions belong on following lines. Internal
 * dispatch comments remain accepted for automation.
 *
 * Env: ATOMA_COMMENT_BODY
 * Writes `matched`, `agent`, `control`, `session_mode`, and `error` to
 * $GITHUB_OUTPUT.
 */
import { appendFileSync } from "node:fs";
import { AGENT_NAME_PATTERN } from "../lib/agent-name.ts";
import { isControlCommand, type ControlCommand } from "../domain/control-commands.ts";
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
  control: ControlCommand;
  sessionMode: "continue" | "recover";
  error: string;
}

const NOTHING: ParsedCommentCommand = { agent: "", control: "", sessionMode: "continue", error: "" };

export function parseCommentCommand(body: string): ParsedCommentCommand {
  if (!body) return NOTHING;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const commandMatch = COMMAND_RE.exec(line);
    if (commandMatch) {
      const name = commandMatch[1]!;
      const modifier = commandMatch[2]?.trim() ?? "";

      // Before the agent branch, so a control command never reaches it. See
      // `domain/control-commands.ts`.
      if (isControlCommand(name)) {
        if (!modifier) return { ...NOTHING, control: name };
        // `/resume 直して` is the one mistake worth naming, because the thing the
        // person wanted exists and is one line away: an ordinary agent command
        // resumes the same session AND carries the instruction, which is why
        // `/resume` deliberately takes none.
        return {
          ...NOTHING,
          error: `'/${name}' takes nothing after it. To resume with an instruction, use '/<agent>' and put the instruction on the following lines.`,
        };
      }

      if (!modifier) return { ...NOTHING, agent: name };
      if (modifier === "recover") return { ...NOTHING, agent: name, sessionMode: "recover" };
      return {
        ...NOTHING,
        error: `Unknown command syntax: '/${name} ${modifier}'. Put instructions on the lines after '/${name}', or use '/${name} recover'.`,
      };
    }
    const dispatchMatch = DISPATCH_RE.exec(line);
    if (dispatchMatch) return { ...NOTHING, agent: dispatchMatch[1]! };
  }
  return NOTHING;
}

function main(): void {
  const body = process.env.ATOMA_COMMENT_BODY ?? "";
  const { agent, control, sessionMode, error } = parseCommentCommand(body);
  const matched = agent ? "true" : "false";

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `matched=${matched}\nagent=${agent}\ncontrol=${control}\n`);
    appendFileSync(githubOutput, `session_mode=${sessionMode}\nerror=${error}\n`);
  }
}

if (import.meta.main) main();

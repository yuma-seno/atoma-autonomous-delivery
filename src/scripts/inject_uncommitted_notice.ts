#!/usr/bin/env bun
/**
 * inject_uncommitted_notice.ts — Append a "please commit" notice to the
 * agent's session.json messages array. Used by atoma-runner.wac.ts when the
 * agent's run left uncommitted working-tree changes.
 *
 * Usage: inject_uncommitted_notice.ts --session <path>
 *
 * ## Why the path is required now
 *
 * This used to search the work tree for the first file called `session.json`,
 * three levels deep, and fall back to that when given no argument. That was
 * harmless while the session lived in the repository root -- the search found the
 * intended file immediately.
 *
 * The session now lives outside the work tree, so the search would find nothing
 * here and, worse, could find something in an adopter's project. A repository with
 * a `session.json` fixture of its own would have this notice appended to THAT file,
 * committed by the same `git add -A` this notice exists to ask for. Searching for a
 * file by name in someone else's tree is not a fallback, it is a guess.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defineScript } from "./lib/script-ref.ts";
import type { Session } from "../lib/session.ts";

export interface InjectUncommittedNoticeArgs {
  session: string;
}

export const ref = defineScript<InjectUncommittedNoticeArgs>(import.meta.url);

function main(): void {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { session: { type: "string" } } });
  const path = values.session;
  if (!path) {
    console.error("usage: inject_uncommitted_notice.ts --session <path>");
    process.exit(2);
  }
  if (!existsSync(path)) {
    // Not an error. The step that calls this runs after a failed or short run
    // too, and a session that was never written is a normal outcome there.
    console.error(`inject_uncommitted_notice: ${path} does not exist; nothing to do`);
    return;
  }
  const session = JSON.parse(readFileSync(path, "utf8")) as Session;
  const messages = session.messages ?? [];
  messages.push({
    role: "user",
    content: "Uncommitted changes exist. Use github__commit_and_push.",
  });
  session.messages = messages;
  writeFileSync(path, JSON.stringify(session, null, 2));
  console.error(`inject_uncommitted_notice: appended notice to ${path}`);
}

if (import.meta.main) main();

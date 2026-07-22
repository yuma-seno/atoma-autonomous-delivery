#!/usr/bin/env bun
/**
 * inject_uncommitted_notice.ts — Append a "please commit" notice to the
 * agent's session.json messages array. Used by atoma-runner.wac.ts when the
 * agent's run left uncommitted working-tree changes.
 *
 * Auto-discovers session.json (mirroring the previous inline
 * `find . -maxdepth 3 -name 'session.json'` bash) so the calling workflow
 * step needs no shell logic of its own -- just `bun run
 * inject_uncommitted_notice.ts`. No-ops quietly if no session.json is found.
 *
 * Usage: inject_uncommitted_notice.ts [path-to-session.json]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface Session {
  messages: { role: string; content: string }[];
  [key: string]: unknown;
}

/** Depth-limited search for the first `session.json`, mirroring `find . -maxdepth 3 -name session.json`. */
function findSessionFile(dir = ".", depth = 3): string | undefined {
  if (depth < 0) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry === "session.json") return full;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir && entry !== "node_modules" && entry !== ".git") {
      const found = findSessionFile(full, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

function main(): void {
  const path = Bun.argv[2] ?? findSessionFile();
  if (!path) {
    console.error("inject_uncommitted_notice: no session.json found; nothing to do");
    return;
  }
  const session = JSON.parse(readFileSync(path, "utf8")) as Session;
  session.messages.push({
    role: "user",
    content: "Uncommitted changes exist. Use github__commit_and_push.",
  });
  writeFileSync(path, JSON.stringify(session, null, 2));
  console.error(`inject_uncommitted_notice: appended notice to ${path}`);
}

if (import.meta.main) main();

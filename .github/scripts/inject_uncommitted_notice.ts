#!/usr/bin/env bun
// @bun

// src/scripts/inject_uncommitted_notice.ts
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/inject_uncommitted_notice.ts
var ref = defineScript(import.meta.url);
function findSessionFile(dir = ".", depth = 3) {
  if (depth < 0)
    return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry === "session.json")
      return full;
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
      if (found)
        return found;
    }
  }
  return;
}
function main() {
  const path = Bun.argv[2] ?? findSessionFile();
  if (!path) {
    console.error("inject_uncommitted_notice: no session.json found; nothing to do");
    return;
  }
  const session = JSON.parse(readFileSync(path, "utf8"));
  const messages = session.messages ?? [];
  messages.push({
    role: "user",
    content: "Uncommitted changes exist. Use github__commit_and_push."
  });
  session.messages = messages;
  writeFileSync(path, JSON.stringify(session, null, 2));
  console.error(`inject_uncommitted_notice: appended notice to ${path}`);
}
if (import.meta.main)
  main();
export {
  ref
};

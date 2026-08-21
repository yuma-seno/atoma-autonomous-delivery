#!/usr/bin/env bun
// @bun

// src/scripts/inject_uncommitted_notice.ts
import { existsSync, readFileSync, writeFileSync } from "fs";
import { parseArgs } from "util";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/inject_uncommitted_notice.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { session: { type: "string" } } });
  const path = values.session;
  if (!path) {
    console.error("usage: inject_uncommitted_notice.ts --session <path>");
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`inject_uncommitted_notice: ${path} does not exist; nothing to do`);
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

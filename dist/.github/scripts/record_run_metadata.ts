#!/usr/bin/env bun
// @bun

// src/scripts/record_run_metadata.ts
import { readFileSync, writeFileSync } from "fs";
import { parseArgs } from "util";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/record_run_metadata.ts
var ref = defineScript(import.meta.url);
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      session: { type: "string" },
      "comment-id": { type: "string" },
      agent: { type: "string" },
      "snapshot-hash": { type: "string" },
      "event-count": { type: "string" },
      type: { type: "string" },
      "resolved-number": { type: "string" }
    }
  });
  if (!values.session) {
    console.error("usage: record_run_metadata.ts --session session.json [...]");
    process.exit(2);
  }
  const session = JSON.parse(readFileSync(values.session, "utf8"));
  if (values["comment-id"] !== undefined) {
    const commentId = Number(values["comment-id"]);
    const messages = session.messages ?? [];
    for (let i = messages.length - 1;i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.content) {
        msg.atoma_metadata = { ...msg.atoma_metadata, github_comment_id: commentId, agent: values.agent };
        break;
      }
    }
    console.error(`Tagged last assistant message with github_comment_id=${commentId}`);
  }
  if (values["snapshot-hash"] !== undefined) {
    const metadata = typeof session.metadata === "object" && session.metadata !== null ? session.metadata : {};
    metadata.github_context = {
      snapshot_hash: values["snapshot-hash"],
      event_count: Number(values["event-count"] ?? 0),
      agent: values.agent,
      type: values.type,
      resolved_number: values["resolved-number"]
    };
    session.metadata = metadata;
    console.error(`Recorded shared context snapshot hash=${values["snapshot-hash"]} for agent=${values.agent}`);
  }
  writeFileSync(values.session, JSON.stringify(session, null, 2) + `
`);
}
if (import.meta.main)
  main();
export {
  ref
};

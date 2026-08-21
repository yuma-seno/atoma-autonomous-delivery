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
function updateRunMetadata(session, update) {
  if (update.commentId !== undefined) {
    const commentId = Number(update.commentId);
    const messages = session.messages ?? [];
    for (let index = messages.length - 1;index >= 0; index--) {
      const message = messages[index];
      if (message.role === "assistant" && message.content) {
        message.atoma_metadata = { ...message.atoma_metadata, github_comment_id: commentId, agent: update.agent };
        break;
      }
    }
  }
  if (update.snapshotHash !== undefined) {
    const metadata = typeof session.metadata === "object" && session.metadata !== null ? session.metadata : {};
    metadata.github_context = {
      ...metadata.github_context,
      snapshot_hash: update.snapshotHash,
      event_count: Number(update.eventCount ?? 0),
      agent: update.agent,
      type: update.type,
      resolved_number: update.resolvedNumber
    };
    session.metadata = metadata;
  }
}
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
  updateRunMetadata(session, {
    commentId: values["comment-id"],
    agent: values.agent,
    snapshotHash: values["snapshot-hash"],
    eventCount: values["event-count"],
    type: values.type,
    resolvedNumber: values["resolved-number"]
  });
  if (values["comment-id"] !== undefined)
    console.error(`Tagged last assistant message with github_comment_id=${values["comment-id"]}`);
  if (values["snapshot-hash"] !== undefined) {
    console.error(`Recorded shared context snapshot hash=${values["snapshot-hash"]} for agent=${values.agent}`);
  }
  writeFileSync(values.session, JSON.stringify(session, null, 2) + `
`);
}
if (import.meta.main)
  main();
export {
  ref,
  updateRunMetadata
};

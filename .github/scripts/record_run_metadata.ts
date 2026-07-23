#!/usr/bin/env bun
/**
 * record_run_metadata.ts — After a successful agent run, records durable
 * metadata into session.json:
 *   1. (if --comment-id given) tags the last assistant message with the
 *      GitHub comment ID that was just posted for it, and which agent
 *      posted it -- used by build_context_session.ts to recognize an
 *      agent's own past result comments and exclude them from its own
 *      future shared context.
 *   2. (if --snapshot-hash given) records the shared GitHub context
 *      snapshot this run processed, so the next run can detect whether
 *      anything new happened at all.
 *
 * Usage:
 *   record_run_metadata.ts --session session.json
 *     [--comment-id ID --agent NAME]
 *     [--snapshot-hash HASH --event-count N --type issue|pr --resolved-number N]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defineScript } from "./lib/script-ref.ts";

export interface RecordRunMetadataArgs {
  session: string;
  "comment-id"?: string | number;
  agent?: string;
  "snapshot-hash"?: string;
  "event-count"?: string | number;
  type?: string;
  "resolved-number"?: string | number;
}

export const ref = defineScript<RecordRunMetadataArgs>(import.meta.url);

interface SessionMessage {
  role: string;
  content?: string;
  atoma_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Session {
  messages: SessionMessage[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      session: { type: "string" },
      "comment-id": { type: "string" },
      agent: { type: "string" },
      "snapshot-hash": { type: "string" },
      "event-count": { type: "string" },
      type: { type: "string" },
      "resolved-number": { type: "string" },
    },
  });

  if (!values.session) {
    console.error("usage: record_run_metadata.ts --session session.json [...]");
    process.exit(2);
  }

  const session = JSON.parse(readFileSync(values.session, "utf8")) as Session;

  if (values["comment-id"] !== undefined) {
    const commentId = Number(values["comment-id"]);
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i]!;
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
      resolved_number: values["resolved-number"],
    };
    session.metadata = metadata;
    console.error(`Recorded shared context snapshot hash=${values["snapshot-hash"]} for agent=${values.agent}`);
  }

  writeFileSync(values.session, JSON.stringify(session, null, 2) + "\n");
}

if (import.meta.main) main();

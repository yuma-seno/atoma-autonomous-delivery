#!/usr/bin/env bun
/**
 * record_run_metadata.ts — After a successful agent run, records durable
 * metadata into session.json:
 *   1. (if --comment-id given) tags the last assistant message with the
 *      GitHub comment ID that was just posted for it, and which agent
 *      posted it -- used by reconcile_github_session.ts to recognize an
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
import type { Session } from "../lib/session.ts";

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

export interface RunMetadataUpdate {
  commentId?: string | number;
  agent?: string;
  snapshotHash?: string;
  eventCount?: string | number;
  type?: string;
  resolvedNumber?: string | number;
}

export function updateRunMetadata(session: Session, update: RunMetadataUpdate): void {
  if (update.commentId !== undefined) {
    const commentId = Number(update.commentId);
    const messages = session.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
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
      resolved_number: update.resolvedNumber,
    };
    session.metadata = metadata;
  }
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
  updateRunMetadata(session, {
    commentId: values["comment-id"],
    agent: values.agent,
    snapshotHash: values["snapshot-hash"],
    eventCount: values["event-count"],
    type: values.type,
    resolvedNumber: values["resolved-number"],
  });
  if (values["comment-id"] !== undefined) console.error(`Tagged last assistant message with github_comment_id=${values["comment-id"]}`);
  if (values["snapshot-hash"] !== undefined) {
    console.error(`Recorded shared context snapshot hash=${values["snapshot-hash"]} for agent=${values.agent}`);
  }

  writeFileSync(values.session, JSON.stringify(session, null, 2) + "\n");
}

if (import.meta.main) main();

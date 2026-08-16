import { describe, expect, test } from "bun:test";
import { updateRunMetadata } from "./record_run_metadata.ts";
import type { Session } from "../lib/session.ts";

describe("record_run_metadata.ts", () => {
  test("preserves the GitHub reconciliation version while updating run metadata", () => {
    const session: Session = {
      messages: [{ role: "assistant", content: "Done" }],
      metadata: { github_context: { version: 1 as const, auto_dispatch_count: 2 } },
    };

    updateRunMetadata(session, {
      commentId: 123,
      agent: "engineer",
      snapshotHash: "hash-2",
      eventCount: 4,
      type: "issue",
      resolvedNumber: 7,
    });

    expect(session.metadata?.github_context).toEqual({
      version: 1,
      auto_dispatch_count: 2,
      snapshot_hash: "hash-2",
      event_count: 4,
      agent: "engineer",
      type: "issue",
      resolved_number: 7,
    });
    expect(session.messages?.[0]?.atoma_metadata?.github_comment_id).toBe(123);
  });
});

import { describe, expect, test } from "bun:test";
import { mergeGithubContext, reconcileGithubSession } from "./reconcile_github_session.ts";
import type { Session } from "../lib/session.ts";

describe("reconcile_github_session.ts", () => {
  test("persists stable GitHub context before history and appends only new events", () => {
    const initial = reconcileGithubSession(
      { messages: [] },
      [{ id: "issue-1", event_type: "issue_opened", content: "Original instruction", author: "alice", created_at: "2026-05-27T09:00:00Z" }],
      "engineer",
    );
    const afterFirstRun = initial.mergedSession;
    afterFirstRun.messages!.push({ role: "assistant", content: "Implemented the first change" });

    const second = reconcileGithubSession(
      afterFirstRun,
      [
        { id: "issue-1", event_type: "issue_opened", content: "Original instruction", author: "alice", created_at: "2026-05-27T09:00:00Z" },
        { id: 101, event_type: "issue_comment", content: "Please adjust it", author: "alice", created_at: "2026-05-27T10:00:00Z" },
      ],
      "engineer",
    );
    const afterSecondMerge = second.mergedSession;

    expect(afterSecondMerge.messages!.map((message) => message.content)).toEqual([
      "Original instruction",
      "Implemented the first change",
      "Please adjust it",
    ]);
  });

  test("updates existing GitHub events in place without duplicating them", () => {
    const original = reconcileGithubSession(
      { messages: [] },
      [{ id: "issue-1", event_type: "issue_opened", content: "Original", author: "alice", created_at: "2026-05-27T09:00:00Z" }],
      "engineer",
    );
    const session = original.mergedSession;
    session.messages!.push({ role: "assistant", content: "Acknowledged" });
    const edited = reconcileGithubSession(
      session,
      [{ id: "issue-1", event_type: "issue_opened", content: "Edited", author: "alice", created_at: "2026-05-27T09:00:00Z" }],
      "engineer",
    );

    expect(edited.mergedSession.messages!.map((message) => message.content)).toEqual([
      "Edited",
      "Acknowledged",
    ]);
  });

  test("keeps a coherent timeline across repeated turns, edits, and deletions", () => {
    const issue = {
      id: "issue-1",
      event_type: "issue_opened",
      content: "Original instruction",
      author: "alice",
      created_at: "2026-05-27T09:00:00Z",
    };
    const commentA = {
      id: 101,
      event_type: "issue_comment",
      content: "First follow-up",
      author: "alice",
      created_at: "2026-05-27T10:00:00Z",
    };
    const commentB = {
      id: 102,
      event_type: "issue_comment",
      content: "Second follow-up",
      author: "alice",
      created_at: "2026-05-27T11:00:00Z",
    };

    const first = reconcileGithubSession({ messages: [] }, [issue], "engineer").mergedSession;
    first.messages!.push({ role: "assistant", content: "First response" });
    const second = reconcileGithubSession(first, [issue, commentA], "engineer").mergedSession;
    second.messages!.push({ role: "assistant", content: "Second response" });
    const third = reconcileGithubSession(second, [issue, commentA, commentB], "engineer").mergedSession;
    third.messages!.push({ role: "assistant", content: "Third response" });
    const final = reconcileGithubSession(
      third,
      [{ ...issue, content: "Edited instruction" }, commentB],
      "engineer",
    ).mergedSession;

    expect(final.messages!.map((message) => message.content)).toEqual([
      "Edited instruction",
      "First response",
      "[Deleted GitHub issue_comment]",
      "Second response",
      "Second follow-up",
      "Third response",
    ]);
    const eventKeys = final.messages!
      .filter((message) => message.atoma_metadata?.source === "github")
      .map((message) => `${message.atoma_metadata?.event_type}:${String(message.atoma_metadata?.id)}`);
    expect(new Set(eventKeys).size).toBe(eventKeys.length);
  });

  test("preserves tool history and appends every comment observed before slash-command dispatch", () => {
    const issue = {
      id: "issue-1",
      event_type: "issue_opened",
      content: "Original instruction",
      author: "alice",
      created_at: "2026-05-27T09:00:00Z",
    };
    const session = reconcileGithubSession({ messages: [] }, [issue], "engineer").mergedSession;
    const agentHistory = [
      {
        role: "assistant",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "github__get_issue", arguments: "{\"number\":1}" } }],
      },
      { role: "tool", tool_call_id: "call-1", content: "Issue details" },
      { role: "assistant", content: "Initial response" },
    ];
    session.messages!.push(...agentHistory);

    const reconciled = reconcileGithubSession(
      session,
      [
        issue,
        { id: 101, event_type: "issue_comment", content: "Plain comment one", author: "alice", created_at: "2026-05-27T10:00:00Z" },
        { id: 102, event_type: "issue_comment", content: "Plain comment two", author: "bob", created_at: "2026-05-27T10:01:00Z" },
        { id: 103, event_type: "issue_comment", content: "/engineer please continue", author: "alice", created_at: "2026-05-27T10:02:00Z" },
      ],
      "engineer",
    ).mergedSession;

    expect(reconciled.messages?.slice(1, 4)).toEqual(agentHistory);
    expect(reconciled.messages?.slice(4).map((message) => message.content)).toEqual([
      "Plain comment one",
      "Plain comment two",
      "/engineer please continue",
    ]);
  });

  test("removes policy-excluded events instead of marking them deleted", () => {
    const events = [
      { id: "pr-1", event_type: "pr_opened", content: "PR body", author: "alice", created_at: "2026-05-27T09:00:00Z" },
      { id: "pr-1-diff", event_type: "pr_diff", content: "diff", author: "github", created_at: "2026-05-27T09:01:00Z" },
    ];
    const first = reconcileGithubSession({ messages: [] }, events, "reviewer").mergedSession;
    const second = reconcileGithubSession(first, events, "reviewer", {
      agents: { reviewer: { shared_context: { exclude_event_types: ["pr_diff"] } } },
    }).mergedSession;

    expect(second.messages!.map((message) => message.content)).toEqual(["PR body"]);
  });

  test("stores the processed snapshot even when no result comment is posted", () => {
    const events = [
      { id: "issue-1", event_type: "issue_opened", content: "Instruction", author: "alice", created_at: "2026-05-27T09:00:00Z" },
    ];
    const first = reconcileGithubSession({ messages: [] }, events, "engineer");
    const second = reconcileGithubSession(first.mergedSession, events, "engineer");

    expect(first.mergedSession.metadata?.github_context?.snapshot_hash).toBe(first.snapshotHash);
    expect(second.changedCount).toBe(0);
  });

  test("removing a GitHub event preserves assistant-tool adjacency", () => {
    const session: Session = {
      messages: [
        {
          role: "user",
          content: "Deleted comment",
          atoma_metadata: { source: "github", layer: "github-context", event_type: "issue_comment", id: 100 },
        },
        { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "result" },
      ],
      metadata: { github_context: { version: 1 as const } },
    };

    const merged = mergeGithubContext(session, []);
    expect(merged.messages!.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(merged.messages![0]?.content).toBe("[Deleted GitHub issue_comment]");
    expect(merged.messages![0]?.atoma_metadata?.deleted).toBe(true);
  });

  test("filters out only the current agent's own result comments", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: "done",
          atoma_metadata: { github_comment_id: 101, agent: "orchestrator" },
        },
      ],
    };
    const events = [
      {
        id: 101,
        event_type: "issue_comment",
        content: "<!-- atoma:agent=orchestrator -->\n/orchestrator handled",
        author: "github-actions[bot]",
        created_at: "2026-05-27T10:00:00Z",
      },
      {
        id: 102,
        event_type: "issue_comment",
        content: "<!-- atoma:agent=engineer -->\n/engineer please implement",
        author: "github-actions[bot]",
        created_at: "2026-05-27T10:01:00Z",
      },
      {
        id: 103,
        event_type: "issue_comment",
        content: "<!-- atoma:sub-result:#7 -->\n/orchestrator sub-task #7 completed.",
        author: "github-actions[bot]",
        created_at: "2026-05-27T10:02:00Z",
      },
    ];

    const { mergedSession, changedCount } = reconcileGithubSession(session, events, "orchestrator");

    const keptIds = mergedSession.messages
      ?.filter((message) => message.atoma_metadata?.source === "github")
      .map((message) => message.atoma_metadata?.id);
    expect(keptIds).toEqual([102, 103]);
    expect(changedCount).toBeGreaterThan(0);
  });

  test("reuses the snapshot hash to skip unchanged context", () => {
    const events = [
      { id: "issue-1", event_type: "issue_opened", content: "Issue #1: test", author: "alice", created_at: "2026-05-27T09:00:00Z" },
    ];

    const initial = reconcileGithubSession({ messages: [] }, events, "engineer");

    const nextSession = {
      messages: [],
      metadata: { github_context: { snapshot_hash: initial.snapshotHash } },
    };
    const next = reconcileGithubSession(nextSession, events, "engineer");

    expect(next.changedCount).toBe(0);
    expect(next.snapshotHash).toBe(initial.snapshotHash);
    expect(next.eventCount).toBe(1);
    expect(next.mergedSession.metadata?.github_context?.snapshot_hash).toBe(initial.snapshotHash);
  });

  test("a human comment containing an agent marker is not filtered", () => {
    const events = [
      {
        id: 301,
        event_type: "issue_comment",
        content: "<!-- atoma:agent=orchestrator -->\nComment copied by a human",
        author: "alice",
        created_at: "2026-05-27T12:00:00Z",
      },
    ];

    const { mergedSession, eventCount } = reconcileGithubSession({ messages: [] }, events, "orchestrator");

    expect(eventCount).toBe(1);
    expect(mergedSession.messages?.[0]?.atoma_metadata?.id).toBe(301);
  });

  test("excludes marked operational notices but keeps human-action notifications", () => {
    const events = [
      {
        id: 302,
        event_type: "issue_comment",
        content: "<!-- atoma:llm-context=exclude -->\nAtoma: Agent `engineer` dispatched.",
        author: "github-actions[bot]",
        created_at: "2026-05-27T12:00:00Z",
      },
      {
        id: 303,
        event_type: "issue_comment",
        content: "@alice Atoma reached the iteration limit. Please review and retry.",
        author: "github-actions[bot]",
        created_at: "2026-05-27T12:01:00Z",
      },
      {
        id: 304,
        event_type: "issue_comment",
        content: "<!-- atoma:llm-context=exclude -->\nHuman instruction must still be visible.",
        author: "alice",
        created_at: "2026-05-27T12:02:00Z",
      },
    ];

    const { mergedSession, eventCount } = reconcileGithubSession({ messages: [] }, events, "engineer");

    expect(eventCount).toBe(2);
    expect(mergedSession.messages?.map((message) => message.content)).toEqual([
      "@alice Atoma reached the iteration limit. Please review and retry.",
      "<!-- atoma:llm-context=exclude -->\nHuman instruction must still be visible.",
    ]);
  });

  test("applies the agent's configured shared_context include/exclude policy", () => {
    const events = [
      { id: "pr-1", event_type: "pr_opened", content: "PR body", author: "alice", created_at: "2026-05-27T12:00:00Z" },
      { id: "pr-1-diff", event_type: "pr_diff", content: "diff", author: "github", created_at: "2026-05-27T12:01:00Z" },
      { id: 401, event_type: "pr_review", content: "needs work", author: "bob", created_at: "2026-05-27T12:02:00Z" },
    ];
    const config = {
      agents: {
        "test-writer": {
          shared_context: { include_event_types: ["pr_opened", "pr_review"], exclude_event_types: ["pr_diff"] },
        },
      },
    };

    const { mergedSession, eventCount } = reconcileGithubSession({ messages: [] }, events, "test-writer", config);

    const keptTypes = mergedSession.messages?.map((message) => message.atoma_metadata?.event_type);
    expect(eventCount).toBe(2);
    expect(keptTypes).toEqual(["pr_opened", "pr_review"]);
  });
});

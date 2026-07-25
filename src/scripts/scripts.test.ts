import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toArgv } from "./lib/cli.ts";
import { buildArgv } from "./get_config_value.ts";
import { mergeGithubContext, reconcileGithubSession } from "./reconcile_github_session.ts";
import { extractDirective } from "./extract_directive.ts";
import { manageDispatchLoop } from "./manage_dispatch_loop.ts";
import { parseAgent } from "./parse_comment_command.ts";
import { buildCommentBody } from "./post_result_comment.ts";
import { updateRunMetadata } from "./record_run_metadata.ts";
import { findAgentSession } from "./restore_agent_session.ts";
import { makeConfigDir, runWithFakeGh } from "./testing/harness.ts";
import type { Session } from "../lib/session.ts";

const SCRIPTS_DIR = "src/scripts";

// Scripts that read config via a cwd-relative path (e.g. `.github/atoma/config.json`)
// are designed to run with cwd = the deployed repo root -- which, for this
// repo's own dev/test purposes (before anything is copied anywhere), is
// `dist/`. Spawn with cwd set there and an absolute script path so the
// relative `bun run <script>` argument still resolves correctly.
function runScript(name: string, env: Record<string, string> = {}) {
  return spawnSync("bun", ["run", join(process.cwd(), SCRIPTS_DIR, name)], {
    encoding: "utf8",
    cwd: join(process.cwd(), "dist"),
    env: { ...process.env, ...env },
  });
}

function parseGithubOutput(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("match_trigger.ts", () => {
  test("PR opened -> reviewer", () => {
    const r = runScript("match_trigger.ts", { EVENT_TYPE: "pull_request.opened" });
    expect(r.stdout.trim()).toBe("reviewer");
  });

  test("changes_requested -> engineer", () => {
    const r = runScript("match_trigger.ts", {
      EVENT_TYPE: "pull_request_review.submitted",
      REVIEW_STATE: "changes_requested",
    });
    expect(r.stdout.trim()).toBe("engineer");
  });

  test("approved -> no match", () => {
    const r = runScript("match_trigger.ts", {
      EVENT_TYPE: "pull_request_review.submitted",
      REVIEW_STATE: "approved",
    });
    expect(r.stdout.trim()).toBe("");
  });
});

describe("config.json", () => {
  test("is valid and matches expected shape", async () => {
    const c = await Bun.file("src/atoma/config.json").json();
    expect(c.agents.orchestrator.max_iterations).toBe(100);
    expect(c.merge_policy).toBe("auto");
    expect(c.labels).toBeDefined();
  });
});

describe("skill catalog", () => {
  test("has valid, unique metadata and non-empty instructions", () => {
    const files: string[] = [];
    const collect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
      }
    };
    collect("src/atoma/skills");

    const names = new Set<string>();
    for (const file of files) {
      const document = readFileSync(file, "utf8");
      const match = document.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
      expect(match, `${file} must have YAML frontmatter and a body`).not.toBeNull();
      const metadata = Bun.YAML.parse(match![1]!) as { name?: string; description?: string };
      expect(metadata.name?.trim(), `${file} name`).toBeTruthy();
      expect(metadata.description?.trim(), `${file} description`).toBeTruthy();
      expect(match![2]!.trim(), `${file} instructions`).toBeTruthy();
      expect(names.has(metadata.name!), `duplicate skill name: ${metadata.name}`).toBe(false);
      names.add(metadata.name!);
    }

    expect(files.length).toBe(5);
  });
});

describe("lib/cli.ts toArgv", () => {
  test("builds quoted --flag value pairs, skipping undefined", () => {
    expect(toArgv({ repo: "owner/repo", parent: 5, empty: undefined })).toEqual(["--repo", '"owner/repo"', "--parent", '"5"']);
  });
});

describe("get_config_value.ts buildArgv", () => {
  test("quotes path and fallback", () => {
    expect(buildArgv("agents.engineer.max_iterations", "30")).toEqual(['"agents.engineer.max_iterations"', '"30"']);
  });
  test("omits fallback when not given", () => {
    expect(buildArgv("labels.in_progress")).toEqual(['"labels.in_progress"']);
  });
});

describe("parse_comment_command.ts", () => {
  test("parses the agent from the first line", () => {
    expect(parseAgent("/engineer fix it\nextra")).toBe("engineer");
  });

  test("parses the agent from a later line", () => {
    expect(parseAgent("some text\n/engineer fix it")).toBe("engineer");
  });

  test("parses the first command when multiple are present", () => {
    expect(parseAgent("/engineer do this\n/orchestrator ignore")).toBe("engineer");
  });

  test("parses the atoma:dispatch= comment form", () => {
    expect(parseAgent("<!-- atoma:dispatch=engineer -->")).toBe("engineer");
  });

  test("ignores a non-command comment", () => {
    expect(parseAgent("please help")).toBe("");
  });

  test("ignores an invalid (uppercase) agent name", () => {
    expect(parseAgent("/Engineer uppercase")).toBe("");
  });
});

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

  test("normalizes legacy linked Issue event keys without duplicating canonical events", () => {
    const legacySession: Session = {
      metadata: { github_context: { version: 1 as const } },
      messages: [{
        role: "user",
        content: "Legacy Issue body",
        atoma_metadata: {
          source: "github",
          layer: "github-context",
          event_type: "linked_issue_opened",
          id: "issue-5",
          author: "alice",
          created_at: "2026-01-01T00:00:00Z",
        },
      }],
    };

    const result = reconcileGithubSession(legacySession, [{
      id: "issue-5",
      event_type: "issue_opened",
      content: "Canonical Issue body",
      author: "alice",
      created_at: "2026-01-01T00:00:00Z",
    }], "engineer");

    expect(result.mergedSession.messages).toHaveLength(1);
    expect(result.mergedSession.messages?.[0]?.content).toBe("Canonical Issue body");
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

  test("migrates an exact legacy snapshot before history and new events after it", () => {
    const oldEvents = [
      { id: "issue-1", event_type: "issue_opened", content: "Instruction", author: "alice", created_at: "2026-05-27T09:00:00Z" },
      { id: 100, event_type: "issue_comment", content: "Earlier comment", author: "alice", created_at: "2026-05-27T10:00:00Z" },
    ];
    const oldBuild = reconcileGithubSession({ messages: [] }, oldEvents, "engineer");
    const legacySession = {
      messages: [{ role: "assistant", content: "Earlier response" }],
      metadata: { github_context: { snapshot_hash: oldBuild.snapshotHash, event_count: 2 } },
    };
    const migrated = reconcileGithubSession(
      legacySession,
      [...oldEvents, { id: 101, event_type: "issue_comment", content: "New comment", author: "alice", created_at: "2026-05-27T11:00:00Z" }],
      "engineer",
    );

    expect(migrated.mergedSession.messages!.map((message) => message.content)).toEqual([
      "Instruction",
      "Earlier comment",
      "Earlier response",
      "New comment",
    ]);
  });

  test("keeps only opening instructions before legacy history when the old snapshot is not a prefix", () => {
    const oldBuild = reconcileGithubSession(
      { messages: [] },
      [
        { id: "issue-1", event_type: "issue_opened", content: "Instruction", author: "alice", created_at: "2026-05-27T09:00:00Z" },
        { id: 100, event_type: "issue_comment", content: "Deleted comment", author: "alice", created_at: "2026-05-27T10:00:00Z" },
      ],
      "engineer",
    );
    const migrated = reconcileGithubSession(
      {
        messages: [{ role: "assistant", content: "Earlier response" }],
        metadata: { github_context: { snapshot_hash: oldBuild.snapshotHash, event_count: 2 } },
      },
      [
        { id: "issue-1", event_type: "issue_opened", content: "Instruction", author: "alice", created_at: "2026-05-27T09:00:00Z" },
        { id: 101, event_type: "issue_comment", content: "Replacement comment", author: "alice", created_at: "2026-05-27T11:00:00Z" },
      ],
      "engineer",
    );

    expect(migrated.mergedSession.messages!.map((message) => message.content)).toEqual([
      "Instruction",
      "Earlier response",
      "Replacement comment",
    ]);
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

describe("restore_agent_session.ts", () => {
  test("prefers the canonical Issue session and falls back to the legacy PR session", () => {
    const sessions = new Map([
      ["sessions/pr-10-reviewer.json", "legacy-pr"],
    ]);
    const load = (target: string) => sessions.get(target);

    expect(findAgentSession("issue", 5, "reviewer", "pr", 10, load)).toEqual({
      target: "sessions/pr-10-reviewer.json",
      content: "legacy-pr",
    });

    sessions.set("sessions/issue-5-reviewer.json", "canonical-issue");
    expect(findAgentSession("issue", 5, "reviewer", "pr", 10, load)).toEqual({
      target: "sessions/issue-5-reviewer.json",
      content: "canonical-issue",
    });
  });
});

describe("extract_directive.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "atoma-defdir-"));
  writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\n---\n");
  writeFileSync(join(dir, "engineer.md"), "---\nname: engineer\n---\n");

  test("extracts a plain slash-command directive", () => {
    expect(extractDirective("Done.\n/reviewer please check this.", dir)).toBe("reviewer");
  });

  test("extracts a markdown-mangled backtick-wrapped directive", () => {
    expect(extractDirective("All set.\n/`engineer`", dir)).toBe("engineer");
  });

  test("ignores a directive that names a non-existent agent", () => {
    expect(extractDirective("/agent reviewer", dir)).toBe("");
  });

  test("returns empty when there is no directive at all", () => {
    expect(extractDirective("Just a plain summary.", dir)).toBe("");
  });
});

describe("fetch_events.ts", () => {
  test("fetches issue events (body + comments) sorted by created_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const outFile = join(dir, "events.json");
      const outputFile = join(dir, "out");
      writeFileSync(outputFile, "");
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "fetch_events.ts"),
        ["--type", "issue", "--number", "5", "--out", outFile],
        {
          env: { GITHUB_REPOSITORY: "owner/repo", GITHUB_OUTPUT: outputFile },
          rules: [
            { match: ["pr", "list"], stdout: "[]" },
            {
              // More specific match listed first: "issues/5/comments" is
              // also a substring-superset of "issues/5", so it must be
              // checked before the plain issue-lookup rule below or that
              // one would win instead.
              match: ["issues/5/comments"],
              stdout: JSON.stringify([{ id: 1, body: "on it", user: { login: "bob" }, created_at: "2026-01-02T00:00:00Z" }]),
            },
            {
              match: ["issues/5"],
              stdout: JSON.stringify({
                number: 5,
                title: "Fix the bug",
                body: "Please fix it.",
                labels: [{ name: "bug" }],
                user: { login: "alice" },
                created_at: "2026-01-01T00:00:00Z",
              }),
            },
          ],
        },
      );

      expect(r.status).toBe(0);
      const events = JSON.parse(readFileSync(outFile, "utf8")) as { event_type: string; content: string }[];
      expect(events.map((e) => e.event_type)).toEqual(["issue_opened", "issue_comment"]);
      expect(events[0]?.content).toContain("Fix the bug");
      expect(events[0]?.content).toContain("**Labels:** bug");
      expect(events[1]?.content).toBe("on it");
      const out = parseGithubOutput(readFileSync(outputFile, "utf8"));
      expect(out.resolved_type).toBe("issue");
      expect(out.resolved_number).toBe("5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps Issue-local context when linked PR search fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-fetch-search-failure-"));
    const eventsFile = join(dir, "events.json");
    const outputFile = join(dir, "output.txt");
    writeFileSync(outputFile, "");

    try {
      const result = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "fetch_events.ts"),
        ["--type", "issue", "--number", "5", "--out", eventsFile],
        {
          env: { GITHUB_REPOSITORY: "owner/repo", GITHUB_OUTPUT: outputFile },
          rules: [
            { match: ["issues/5/comments"], stdout: "[]" },
            {
              match: ["issues/5"],
              stdout: JSON.stringify({
                number: 5,
                title: "Fix the bug",
                body: "Please fix it.",
                labels: [],
                user: { login: "alice" },
                created_at: "2026-01-01T00:00:00Z",
              }),
            },
          ],
        },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(eventsFile, "utf8"))).toHaveLength(1);
      expect(result.stderr).toContain("Could not search linked PRs for Issue #5");
      expect(parseGithubOutput(readFileSync(outputFile, "utf8"))).toMatchObject({ resolved_type: "issue", resolved_number: "5" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Issue and linked PR runs produce the same serial context and canonical key", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-fetch-linked-"));
    const issueEventsFile = join(dir, "issue-events.json");
    const prEventsFile = join(dir, "pr-events.json");
    const issueOutput = join(dir, "issue-output.txt");
    const prOutput = join(dir, "pr-output.txt");
    writeFileSync(issueOutput, "");
    writeFileSync(prOutput, "");
    const rules = [
      { match: ["pr", "list"], stdout: JSON.stringify([{ number: 10 }, { number: 11 }]) },
      { match: ["pulls/10", "application/vnd.github.v3.diff"], stdout: "diff --git a/a b/a\n+change" },
      { match: ["pulls/10/comments"], stdout: JSON.stringify([{ id: 1002, path: "a", line: 1, original_line: 1, body: "inline", user: { login: "carol" }, created_at: "2026-01-04T00:00:00Z" }]) },
      { match: ["pulls/10/reviews"], stdout: JSON.stringify([{ id: 1001, body: "looks good", state: "APPROVED", user: { login: "bob" }, submitted_at: "2026-01-03T00:00:00Z" }]) },
      { match: ["issues/10/comments"], stdout: JSON.stringify([{ id: 1000, body: "PR discussion", user: { login: "alice" }, created_at: "2026-01-02T12:00:00Z" }]) },
      {
        match: ["pulls/10"],
        stdout: JSON.stringify({
          number: 10,
          title: "Implement fix",
          body: "<!-- atoma:parent-issue=5 -->\nCloses #5",
          user: { login: "engineer" },
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T06:00:00Z",
          labels: [],
          head: { sha: "1234567890" },
        }),
      },
      { match: ["pulls/11", "application/vnd.github.v3.diff"], stdout: "" },
      { match: ["pulls/11/comments"], stdout: "[]" },
      { match: ["pulls/11/reviews"], stdout: "[]" },
      { match: ["issues/11/comments"], stdout: "[]" },
      {
        match: ["pulls/11"],
        stdout: JSON.stringify({
          number: 11,
          title: "Follow-up fix",
          body: "<!-- atoma:parent-issue=5 -->\nFollow-up",
          user: { login: "engineer" },
          created_at: "2026-01-05T00:00:00Z",
          updated_at: "2026-01-05T01:00:00Z",
          labels: [],
          head: { sha: "abcdefghij" },
        }),
      },
      { match: ["issues/5/comments"], stdout: JSON.stringify([{ id: 500, body: "Issue discussion", user: { login: "alice" }, created_at: "2026-01-01T12:00:00Z" }]) },
      {
        match: ["issues/5"],
        stdout: JSON.stringify({
          number: 5,
          title: "Fix the bug",
          body: "Please fix it.",
          labels: [],
          user: { login: "alice" },
          created_at: "2026-01-01T00:00:00Z",
        }),
      },
    ];

    try {
      const issueRun = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "fetch_events.ts"),
        ["--type", "issue", "--number", "5", "--out", issueEventsFile],
        { env: { GITHUB_REPOSITORY: "owner/repo", GITHUB_OUTPUT: issueOutput }, rules },
      );
      const prRun = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "fetch_events.ts"),
        ["--type", "pr", "--number", "10", "--out", prEventsFile],
        { env: { GITHUB_REPOSITORY: "owner/repo", GITHUB_OUTPUT: prOutput }, rules },
      );

      expect(issueRun.status).toBe(0);
      expect(prRun.status).toBe(0);
      expect(JSON.parse(readFileSync(issueEventsFile, "utf8"))).toEqual(JSON.parse(readFileSync(prEventsFile, "utf8")));
      expect(parseGithubOutput(readFileSync(issueOutput, "utf8"))).toMatchObject({ resolved_type: "issue", resolved_number: "5" });
      expect(parseGithubOutput(readFileSync(prOutput, "utf8"))).toMatchObject({ resolved_type: "issue", resolved_number: "5" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("post_result_comment.ts buildCommentBody", () => {
  test("mentions notify when there is no directive and the chain does not continue", () => {
    const body = buildCommentBody({
      agent: "orchestrator",
      notify: "octocat",
      runUrl: "http://example.com/run/1",
      output: "All done.",
      usageLines: [],
    });
    expect(body).toContain("<!-- atoma:agent=orchestrator -->");
    expect(body).toContain("All done.");
    expect(body).toContain("@octocat");
    expect(body).toContain("_run by [orchestrator](http://example.com/run/1)_");
  });

  test("omits the mention when a directive is present", () => {
    const body = buildCommentBody({
      agent: "orchestrator",
      notify: "octocat",
      directive: "engineer",
      runUrl: "http://example.com/run/1",
      output: "Handing off.",
      usageLines: [],
    });
    expect(body).not.toContain("@octocat");
  });

  test("omits the mention when the chain already continues", () => {
    const body = buildCommentBody({
      agent: "orchestrator",
      notify: "octocat",
      chainContinues: "true",
      runUrl: "http://example.com/run/1",
      output: "Dispatched.",
      usageLines: [],
    });
    expect(body).not.toContain("@octocat");
  });

  test("appends the max-iterations warning", () => {
    const body = buildCommentBody({
      agent: "engineer",
      maxIterationsReached: "true",
      runUrl: "http://example.com/run/1",
      output: "Still working.",
      usageLines: [],
    });
    expect(body).toContain("Max iterations reached");
    expect(body).toContain("`/engineer`");
  });
});

describe("post_result_comment.ts main", () => {
  test("skips posting entirely when atoma_output.txt is missing (session ended via a tool call)", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-post-result-"));
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "post_result_comment.ts"),
        ["--number", "5", "--agent", "orchestrator", "--notify", "octocat", "--run-url", "http://example.com/run/1"],
        { cwd: dir, rules: [{ match: ["api", "comments"] }] },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips posting entirely when atoma_output.txt is blank", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-post-result-"));
    writeFileSync(join(dir, "atoma_output.txt"), "   \n");
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "post_result_comment.ts"),
        ["--number", "5", "--agent", "orchestrator", "--run-url", "http://example.com/run/1"],
        { cwd: dir, rules: [{ match: ["api", "comments"] }] },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("posts normally when atoma_output.txt has real content", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-post-result-"));
    writeFileSync(join(dir, "atoma_output.txt"), "All done.");
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "post_result_comment.ts"),
        ["--number", "5", "--agent", "orchestrator", "--run-url", "http://example.com/run/1"],
        { cwd: dir, env: { GITHUB_REPOSITORY: "owner/repo" }, rules: [{ match: ["api", "comments"], stdout: "42" }] },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.join(" ").includes("comments"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("manage_dispatch_loop.ts", () => {
  test("resets the counter when new events are present", () => {
    const { autoDispatchCount, loopLimitReached } = manageDispatchLoop(
      { metadata: { github_context: { auto_dispatch_count: 4 } } },
      1,
      "engineer",
    );
    expect(autoDispatchCount).toBe(0);
    expect(loopLimitReached).toBe(false);
  });

  test("increments the counter on a no-new-event auto-dispatch", () => {
    const { session, autoDispatchCount } = manageDispatchLoop(
      { metadata: { github_context: { auto_dispatch_count: 2 } } },
      0,
      "engineer",
    );
    expect(autoDispatchCount).toBe(3);
    expect(session.metadata?.github_context?.auto_dispatch_count).toBe(3);
  });

  test("does not increment when there is no directive", () => {
    const { autoDispatchCount } = manageDispatchLoop({ metadata: { github_context: { auto_dispatch_count: 2 } } }, 0, "");
    expect(autoDispatchCount).toBe(2);
  });

  test("reports loop_limit_reached once the count hits 5", () => {
    const { loopLimitReached } = manageDispatchLoop({ metadata: { github_context: { auto_dispatch_count: 4 } } }, 0, "engineer");
    expect(loopLimitReached).toBe(true);
  });
});

describe("extract_notify_tag.ts", () => {
  test("extracts the notify tag from a PR body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    const r = spawnSync("bun", ["run", `${SCRIPTS_DIR}/extract_notify_tag.ts`], {
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "<!-- atoma:notify=octocat -->\nsome body", GITHUB_OUTPUT: outputFile },
    });
    expect(r.status).toBe(0);
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.notify).toBe("octocat");
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty when no tag present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/extract_notify_tag.ts`], {
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "no tag here", GITHUB_OUTPUT: outputFile },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.notify).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parse_pr_metadata.ts", () => {
  test("parses parent-issue and Closes # references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/parse_pr_metadata.ts`], {
      encoding: "utf8",
      env: {
        ...process.env,
        PR_BODY: "<!-- atoma:parent-issue=42 -->\nCloses #7\nsome body",
        PR_NUMBER: "99",
        GITHUB_OUTPUT: outputFile,
      },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.parent_number).toBe("42");
    expect(out.sub_number).toBe("7");
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty outputs when no metadata present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/parse_pr_metadata.ts`], {
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "plain body", PR_NUMBER: "1", GITHUB_OUTPUT: outputFile },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.parent_number).toBe("");
    expect(out.sub_number).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("resolve_entry_agent.ts", () => {
  test("emits agent/number/type/notify when body starts with a slash command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const eventFile = join(dir, "event.json");
    const outputFile = join(dir, "out");
    writeFileSync(eventFile, JSON.stringify({ issue: { body: "/orchestrator\n\nDo the thing." } }));
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/resolve_entry_agent.ts`], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_OUTPUT: outputFile,
        NUMBER: "123",
        SENDER: "octocat",
      },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.agent).toBe("orchestrator");
    expect(out.number).toBe("123");
    expect(out.type).toBe("issue");
    expect(out.notify).toBe("octocat");
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes nothing when body has no slash command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const eventFile = join(dir, "event.json");
    const outputFile = join(dir, "out");
    writeFileSync(eventFile, JSON.stringify({ issue: { body: "just a regular issue" } }));
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/resolve_entry_agent.ts`], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile, NUMBER: "1", SENDER: "x" },
    });
    const out = await Bun.file(outputFile).text();
    expect(out.trim()).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("manage_in_progress_label.ts", () => {
  test("adds the in_progress label", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "manage_in_progress_label.ts"), ["--action", "add", "--number", "42"], {
        cwd: configDir,
        rules: [{ match: ["label"] }, { match: ["issue", "edit"] }],
      });
      expect(r.status).toBe(0);
      const editCall = r.ghCalls.find((c) => c.includes("edit"));
      expect(editCall).toContain("--add-label");
      expect(editCall).toContain("atoma/in-progress");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("removes the in_progress label", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "manage_in_progress_label.ts"), ["--action", "remove", "--number", "42"], {
        cwd: configDir,
        rules: [{ match: ["issue", "edit"] }],
      });
      expect(r.status).toBe(0);
      const editCall = r.ghCalls.find((c) => c.includes("edit"));
      expect(editCall).toContain("--remove-label");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("decide_guard_release.ts", () => {
  function run(args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "atoma-guard-release-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    try {
      const r = spawnSync("bun", ["run", join(process.cwd(), SCRIPTS_DIR, "decide_guard_release.ts"), ...args], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: outputFile },
      });
      return { status: r.status, out: parseGithubOutput(readFileSync(outputFile, "utf8")) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("releases on a failed run outcome", () => {
    const { status, out } = run(["--outcome", "failure"]);
    expect(status).toBe(0);
    expect(out.should_release).toBe("true");
  });

  test("stays held when a directive hands off to another agent", () => {
    const { out } = run(["--outcome", "success", "--directive", "reviewer"]);
    expect(out.should_release).toBe("false");
  });

  test("stays held when the chain already continues via a tool-triggered dispatch", () => {
    const { out } = run(["--outcome", "success", "--chain-continues", "true"]);
    expect(out.should_release).toBe("false");
  });

  test("releases when max_iterations was reached even mid-chain", () => {
    const { out } = run(["--outcome", "success", "--max-iterations-reached", "true", "--chain-continues", "true"]);
    expect(out.should_release).toBe("true");
  });

  test("releases when nothing further is happening", () => {
    const { out } = run(["--outcome", "success"]);
    expect(out.should_release).toBe("true");
  });

  test("fails open (releases) when --outcome is missing entirely, instead of leaving the guard stuck", () => {
    const { status, out } = run([]);
    expect(status).toBe(0);
    expect(out.should_release).toBe("true");
  });
});

describe("guard_comment_during_run.ts", () => {
  test("deletes the comment and notifies the commenter when in_progress is set", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "guard_comment_during_run.ts"),
        ["--number", "9", "--comment-id", "123", "--commenter", "octocat"],
        {
          cwd: configDir,
          env: { GITHUB_REPOSITORY: "owner/repo" },
          rules: [
            { match: ["issue", "view", "labels"], stdout: "true" },
            { match: ["api", "DELETE"] },
            { match: ["issue", "comment"] },
          ],
        },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("DELETE") && c.join(" ").includes("comments/123"))).toBe(true);
      const commentCall = r.ghCalls.find((c) => c.includes("comment"));
      expect(commentCall?.join(" ")).toContain("@octocat");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("leaves the comment alone when the issue is not in_progress", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "guard_comment_during_run.ts"),
        ["--number", "9", "--comment-id", "123", "--commenter", "octocat"],
        {
          cwd: configDir,
          env: { GITHUB_REPOSITORY: "owner/repo" },
          rules: [{ match: ["issue", "view", "labels"], stdout: "false" }],
        },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("DELETE"))).toBe(false);
      expect(r.ghCalls.some((c) => c.includes("comment"))).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("notify_max_iterations.ts", () => {
  test("mentions the notify login when given", () => {
    const r = runWithFakeGh(
      join(process.cwd(), SCRIPTS_DIR, "notify_max_iterations.ts"),
      ["--number", "7", "--agent", "engineer", "--notify", "octocat"],
      { rules: [{ match: ["issue", "comment"] }] },
    );
    expect(r.status).toBe(0);
    const commentCall = r.ghCalls.find((c) => c.includes("comment"));
    expect(commentCall?.join(" ")).toContain("@octocat");
    expect(commentCall?.join(" ")).toContain("engineer");
  });

  test("omits the mention when notify is not given", () => {
    const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "notify_max_iterations.ts"), ["--number", "7", "--agent", "engineer"], {
      rules: [{ match: ["issue", "comment"] }],
    });
    expect(r.status).toBe(0);
    const commentCall = r.ghCalls.find((c) => c.includes("comment"));
    expect(commentCall?.join(" ")).not.toContain("@");
  });
});

describe("resolve_notify.ts", () => {
  test("returns the atoma:notify tag when present", () => {
    const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "resolve_notify.ts"), ["--repo", "owner/repo", "--number", "5"], {
      rules: [{ match: ["issues/5"], stdout: JSON.stringify({ body: "<!-- atoma:notify=octocat -->", login: "some-bot", type: "Bot" }) }],
    });
    expect(r.stdout.trim()).toBe("octocat");
  });

  test("falls back to the human author when no tag is present", () => {
    const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "resolve_notify.ts"), ["--repo", "owner/repo", "--number", "5"], {
      rules: [{ match: ["issues/5"], stdout: JSON.stringify({ body: "no tag", login: "alice", type: "User" }) }],
    });
    expect(r.stdout.trim()).toBe("alice");
  });

  test("walks the atoma:parent chain when neither a tag nor a human author is available", () => {
    const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "resolve_notify.ts"), ["--repo", "owner/repo", "--number", "5"], {
      rules: [
        { match: ["issues/5"], stdout: JSON.stringify({ body: "<!-- atoma:parent=#2 -->", login: "some-bot", type: "Bot" }) },
        { match: ["issues/2"], stdout: JSON.stringify({ body: "no tag", login: "bob", type: "User" }) },
      ],
    });
    expect(r.stdout.trim()).toBe("bob");
  });
});

describe("resolve_orchestrator_parent.ts", () => {
  test("resolves the parent via the GraphQL sub-issues API", () => {
    // gh api graphql wraps the real GraphQL response in a top-level "data"
    // envelope -- lib/gh.ts's ghGraphql() unwraps `.data`, so the fake gh's
    // canned stdout must match that shape too.
    const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "resolve_orchestrator_parent.ts"), ["--repo", "owner/repo", "--sub", "9"], {
      rules: [{ match: ["graphql"], stdout: JSON.stringify({ data: { repository: { issue: { parent: { number: 3 } } } } }) }],
    });
    expect(r.stdout.trim()).toBe("3");
  });

  test("falls back to the atoma:parent body comment when GraphQL has no parent", () => {
    const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "resolve_orchestrator_parent.ts"), ["--repo", "owner/repo", "--sub", "9"], {
      rules: [
        { match: ["graphql"], stdout: JSON.stringify({ data: { repository: { issue: { parent: null } } } }) },
        { match: ["issue", "view"], stdout: "<!-- atoma:parent=#4 -->" },
      ],
    });
    expect(r.stdout.trim()).toBe("4");
  });
});

describe("check_sub_issue_closure.ts", () => {
  test("detects a sub-issue and reports closed_via_pr=false when not closed via PR", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const eventFile = join(dir, "event.json");
      const outputFile = join(dir, "out");
      writeFileSync(eventFile, JSON.stringify({ issue: { body: "<!-- atoma:parent=#3 -->\nsome body" } }));
      writeFileSync(outputFile, "");
      runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "check_sub_issue_closure.ts"), [], {
        env: { GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile, CLOSED_NUM: "9", OWNER: "owner", REPO: "repo" },
        // gh api graphql wraps its response in a top-level "data" envelope --
        // ghGraphql() unwraps `.data`, so the fake gh's canned stdout must too.
        rules: [
          {
            match: ["graphql"],
            stdout: JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } } }),
          },
        ],
      });
      const out = parseGithubOutput(readFileSync(outputFile, "utf8"));
      expect(out.is_sub_issue).toBe("true");
      expect(out.parent_number).toBe("3");
      expect(out.closed_via_pr).toBe("false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports closed_via_pr=true when the sub-issue was already closed by a merged PR", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const eventFile = join(dir, "event.json");
      const outputFile = join(dir, "out");
      writeFileSync(eventFile, JSON.stringify({ issue: { body: "<!-- atoma:parent=#3 -->\nsome body" } }));
      writeFileSync(outputFile, "");
      runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "check_sub_issue_closure.ts"), [], {
        env: { GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile, CLOSED_NUM: "9", OWNER: "owner", REPO: "repo" },
        rules: [
          {
            match: ["graphql"],
            stdout: JSON.stringify({
              data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: 12 }] } } } },
            }),
          },
        ],
      });
      const out = parseGithubOutput(readFileSync(outputFile, "utf8"));
      expect(out.closed_via_pr).toBe("true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports is_sub_issue=false when there is no atoma:parent tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const eventFile = join(dir, "event.json");
      const outputFile = join(dir, "out");
      writeFileSync(eventFile, JSON.stringify({ issue: { body: "just a regular issue" } }));
      writeFileSync(outputFile, "");
      runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "check_sub_issue_closure.ts"), [], {
        env: { GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile, CLOSED_NUM: "9", OWNER: "owner", REPO: "repo" },
      });
      const out = parseGithubOutput(readFileSync(outputFile, "utf8"));
      expect(out.is_sub_issue).toBe("false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run_environment_setup.ts", () => {
  test("runs configured setup commands in order", () => {
    const dir = makeConfigDir({ environment: { setup_commands: ["echo one", "echo two"] } });
    try {
      const r = spawnSync("bun", ["run", join(process.cwd(), SCRIPTS_DIR, "run_environment_setup.ts")], { encoding: "utf8", cwd: dir });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("one");
      expect(r.stdout).toContain("two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aborts with the failing command's exit code", () => {
    const dir = makeConfigDir({ environment: { setup_commands: ["exit 3"] } });
    try {
      const r = spawnSync("bun", ["run", join(process.cwd(), SCRIPTS_DIR, "run_environment_setup.ts")], { encoding: "utf8", cwd: dir });
      expect(r.status).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-ops quietly when no setup_commands are configured", () => {
    const dir = makeConfigDir({});
    try {
      const r = spawnSync("bun", ["run", join(process.cwd(), SCRIPTS_DIR, "run_environment_setup.ts")], { encoding: "utf8", cwd: dir });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("skipping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("inject_uncommitted_notice.ts", () => {
  test("appends a commit-and-push notice to the given session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const sessionFile = join(dir, "session.json");
      writeFileSync(sessionFile, JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
      const r = spawnSync("bun", ["run", join(process.cwd(), SCRIPTS_DIR, "inject_uncommitted_notice.ts"), sessionFile], {
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      const session = JSON.parse(readFileSync(sessionFile, "utf8")) as { messages: { role: string; content: string }[] };
      expect(session.messages.at(-1)?.content).toContain("github__commit_and_push");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-ops quietly when no session.json can be found", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const r = spawnSync("bun", ["run", join(process.cwd(), SCRIPTS_DIR, "inject_uncommitted_notice.ts")], { encoding: "utf8", cwd: dir });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("nothing to do");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dispatch_if_siblings_done.ts", () => {
  test("dispatches the orchestrator once all siblings are done", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "dispatch_if_siblings_done.ts"),
        ["--repo", "owner/repo", "--parent", "5", "--closed-num", "9"],
        {
          cwd: configDir,
          rules: [
            { match: ["issue", "list"], stdout: "[]" },
            { match: ["issue", "view", "comments"], stdout: "" },
            { match: ["issue", "comment"] },
            { match: ["workflow", "run"] },
          ],
        },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("comment"))).toBe(true);
      expect(r.ghCalls.some((c) => c[0] === "workflow" && c[1] === "run")).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("skips dispatch when the aggregation marker is already present", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "dispatch_if_siblings_done.ts"),
        ["--repo", "owner/repo", "--parent", "5", "--closed-num", "9"],
        {
          cwd: configDir,
          rules: [
            { match: ["issue", "list"], stdout: "[]" },
            { match: ["issue", "view", "comments"], stdout: "<!-- atoma:aggregated=9 -->\nAtoma: All sub-tasks completed." },
          ],
        },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("comment"))).toBe(false);
      expect(r.ghCalls.some((c) => c[0] === "workflow")).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("does nothing when siblings are still open", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "dispatch_if_siblings_done.ts"),
        ["--repo", "owner/repo", "--parent", "5", "--closed-num", "9"],
        { cwd: configDir, rules: [{ match: ["issue", "list"], stdout: JSON.stringify([{ number: 1 }]) }] },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("comment"))).toBe(false);
      expect(r.ghCalls.some((c) => c[0] === "workflow")).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("aggregate_sub_issues.ts", () => {
  test("posts a progress comment and returns early when siblings remain open", () => {
    // Needs BOTH a real git repo (the gitRun("config", ...) calls at the top
    // of main() need one) AND a .github/atoma/config.json (the nested
    // check_open_siblings.ts call inherits this same cwd and reads config.json
    // via getLabel()) in the SAME directory.
    const dir = makeConfigDir({});
    spawnSync("git", ["init"], { cwd: dir });
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "aggregate_sub_issues.ts"),
        ["--repo", "owner/repo", "--parent", "5", "--closed-num", "9"],
        { cwd: dir, rules: [{ match: ["issue", "list"], stdout: JSON.stringify([{ number: 1 }]) }] },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Not all sub-tasks done yet");
      const commentCall = r.ghCalls.find((c) => c.includes("comment"));
      expect(commentCall?.join(" ")).toContain("atoma:sub-result=9");
      // The full aggregation path (siblingCount === 0) additionally performs
      // real `git` operations against an `atoma-data` branch/remote
      // (checkout --orphan, commit, push-with-retry-on-race) -- deliberately
      // not covered here; it would need a full git remote fixture for
      // comparatively low additional confidence over this early-return path.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

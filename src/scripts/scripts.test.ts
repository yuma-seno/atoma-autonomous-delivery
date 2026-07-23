import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toArgv } from "./lib/cli.ts";
import { buildArgv } from "./get_config_value.ts";
import { buildContextSession } from "./build_context_session.ts";
import { extractDirective } from "./extract_directive.ts";
import { manageDispatchLoop } from "./manage_dispatch_loop.ts";
import { parseAgent } from "./parse_comment_command.ts";
import { buildCommentBody } from "./post_result_comment.ts";
import { makeConfigDir, runWithFakeGh } from "./testing/harness.ts";

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
    const c = await Bun.file("dist/.github/atoma/config.json").json();
    expect(c.version).toBe(4);
    expect(c.agents.orchestrator.max_iterations).toBe(100);
    expect(c.merge_policy).toBe("auto");
    expect(c.labels).toBeDefined();
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

describe("build_context_session.ts", () => {
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

    const { contextSession, changedCount } = buildContextSession(session, events, "orchestrator");

    const keptIds = contextSession.messages.map((m) => m.atoma_metadata.id);
    expect(keptIds).toEqual([102, 103]);
    expect(changedCount).toBeGreaterThan(0);
  });

  test("reuses the snapshot hash to skip unchanged context", () => {
    const events = [
      { id: "issue-1", event_type: "issue_opened", content: "Issue #1: test", author: "alice", created_at: "2026-05-27T09:00:00Z" },
    ];

    const initial = buildContextSession({ messages: [] }, events, "engineer");

    const nextSession = {
      messages: [],
      metadata: { github_context: { snapshot_hash: initial.snapshotHash } },
    };
    const next = buildContextSession(nextSession, events, "engineer");

    expect(next.changedCount).toBe(0);
    expect(next.snapshotHash).toBe(initial.snapshotHash);
    expect(next.eventCount).toBe(1);
    expect(next.contextSession.metadata.snapshot_hash).toBe(initial.snapshotHash);
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

    const { contextSession, eventCount } = buildContextSession({ messages: [] }, events, "orchestrator");

    expect(eventCount).toBe(1);
    expect(contextSession.messages[0]?.atoma_metadata.id).toBe(301);
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

    const { contextSession, eventCount } = buildContextSession({ messages: [] }, events, "test-writer", config);

    const keptTypes = contextSession.messages.map((m) => m.atoma_metadata.event_type);
    expect(eventCount).toBe(2);
    expect(keptTypes).toEqual(["pr_opened", "pr_review"]);
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
      expect(out.resolved_number).toBe("5");
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

describe("check_open_siblings.ts", () => {
  test("counts open siblings via gh issue list", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "check_open_siblings.ts"), ["--repo", "owner/repo", "--parent", "5"], {
        cwd: configDir,
        rules: [{ match: ["issue", "list"], stdout: JSON.stringify([{ number: 10 }, { number: 11 }]) }],
      });
      expect(r.stdout.trim()).toBe("2");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("prints 0 when no siblings are open", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(join(process.cwd(), SCRIPTS_DIR, "check_open_siblings.ts"), ["--repo", "owner/repo", "--parent", "5"], {
        cwd: configDir,
        rules: [{ match: ["issue", "list"], stdout: "[]" }],
      });
      expect(r.stdout.trim()).toBe("0");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
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

describe("inject_sub_results.ts", () => {
  test("replaces the last tool message with an aggregated summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const sessionFile = join(dir, "session.json");
      const outFile = join(dir, "out.json");
      writeFileSync(
        sessionFile,
        JSON.stringify({
          messages: [
            { role: "user", content: "go" },
            { role: "tool", content: "launched" },
          ],
        }),
      );
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "inject_sub_results.ts"),
        ["--session", sessionFile, "--repo", "owner/repo", "--parent", "1", "--sub-issues", "2,3", "--out", outFile],
        {
          rules: [
            { match: ["issue", "view", "2"], stdout: JSON.stringify({ title: "Fix A", state: "CLOSED" }) },
            { match: ["issue", "view", "3"], stdout: JSON.stringify({ title: "Fix B", state: "CLOSED" }) },
            { match: ["pr", "list", "merged"], stdout: JSON.stringify([{ number: 10, title: "Fix A", url: "http://x/10" }]) },
            { match: ["pr", "list", "open"], stdout: "[]" },
          ],
        },
      );
      expect(r.status).toBe(0);
      const session = JSON.parse(readFileSync(outFile, "utf8")) as { messages: { role: string; content: string }[] };
      const toolMsg = session.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("Fix A");
      expect(toolMsg?.content).toContain("Fix B");
      expect(toolMsg?.content).toContain("PR #10");
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
        ["--repo", "owner/repo", "--parent", "5"],
        {
          cwd: configDir,
          rules: [{ match: ["issue", "list"], stdout: "[]" }, { match: ["issue", "comment"] }, { match: ["workflow", "run"] }],
        },
      );
      expect(r.status).toBe(0);
      expect(r.ghCalls.some((c) => c.includes("comment"))).toBe(true);
      expect(r.ghCalls.some((c) => c[0] === "workflow" && c[1] === "run")).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("does nothing when siblings are still open", () => {
    const configDir = makeConfigDir({});
    try {
      const r = runWithFakeGh(
        join(process.cwd(), SCRIPTS_DIR, "dispatch_if_siblings_done.ts"),
        ["--repo", "owner/repo", "--parent", "5"],
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
      expect(commentCall?.join(" ")).toContain("atoma:sub-result:#9");
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

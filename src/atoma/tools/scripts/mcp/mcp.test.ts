import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS_DIR = join(process.cwd(), "src/atoma/tools/scripts/mcp");
const FAKE_GH_BIN_DIR = join(process.cwd(), "src/scripts/testing/bin");

/**
 * Send one JSON-RPC request to a server and resolve its first response line.
 *
 * `timeoutMs` is a parameter rather than a fixed five seconds because how long a
 * server takes to answer `initialize` is a property of that server, not of this
 * harness. Every server tested here answers well inside the default; the one
 * that does not is `search.ts`, and it is not tested here at all -- see the note
 * at the bottom of this file for why.
 */
function sendRequest(
  script: string,
  request: Record<string, unknown>,
  env: Record<string, string> = {},
  cwd = process.cwd(),
  extraArgs: string[] = [],
  timeoutMs = 5000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", `${SCRIPTS_DIR}/${script}`, ...extraArgs], {
      env: { ...process.env, GITHUB_REPOSITORY: "owner/repo", ...env },
      cwd,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for response from ${script}`));
    }, timeoutMs);
    child.stdout.on("data", () => {
      const line = out.split("\n").find((l) => l.trim());
      if (line) {
        clearTimeout(timer);
        child.kill();
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

const INIT_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test-client", version: "1.0.0" },
};

const INIT_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: INIT_PARAMS,
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRemoteBranchFixture(): { root: string; seed: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "atoma-sync-branch-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  git(root, "init", "--bare", "--initial-branch=atoma/issue-1", remote);
  git(root, "init", "--initial-branch=atoma/issue-1", seed);
  git(seed, "config", "user.name", "Atoma Test");
  git(seed, "config", "user.email", "atoma@example.com");
  writeFileSync(join(seed, "value.txt"), "one\n");
  git(seed, "add", "value.txt");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "atoma/issue-1");
  git(root, "clone", "--branch", "atoma/issue-1", remote, work);
  return { root, seed, work };
}

function advanceRemote(seed: string): string {
  writeFileSync(join(seed, "value.txt"), "two\n");
  git(seed, "add", "value.txt");
  git(seed, "commit", "-m", "remote update");
  git(seed, "push", "origin", "atoma/issue-1");
  return git(seed, "rev-parse", "HEAD");
}

describe("mcp/github.ts", () => {
  test("initialize returns server info", async () => {
    const r = await sendRequest("github.ts", {
      jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS,
    });
    expect(r.result.serverInfo.name).toBe("atoma-github-mcp");
  });

  test("tools/list exposes the expected tool set", async () => {
    const r = await sendRequest("github.ts", {
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    });
    const names = r.result.tools.map((t: { name: string }) => t.name);
    for (const tool of ["create_issue", "create_pr", "get_issue", "search_code", "get_pr_diff", "sync_branch"]) {
      expect(names).toContain(tool);
    }
  });

  test("sync_branch fast-forwards a clean branch from origin", async () => {
    const { root, seed, work } = makeRemoteBranchFixture();

    try {
      const remoteHead = advanceRemote(seed);

      const response = await sendRequest(
        "github.ts",
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "sync_branch", arguments: {} } },
        { BRANCH: "atoma/issue-1" },
        work,
      );
      const result = JSON.parse(response.result.content[0].text) as { status: string; behind: number };
      expect(result).toMatchObject({ status: "fast_forwarded", behind: 1 });
      expect(git(work, "rev-parse", "HEAD")).toBe(remoteHead);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("create_pr rejects an unsynchronized HEAD without pushing", async () => {
    const { root, seed, work } = makeRemoteBranchFixture();
    try {
      advanceRemote(seed);
      const localHead = git(work, "rev-parse", "HEAD");

      const response = await sendRequest(
        "github.ts",
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "create_pr", arguments: { title: "Test PR" } },
        },
        { BRANCH: "atoma/issue-1" },
        work,
      );
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain("Call github__sync_branch");
      expect(git(work, "rev-parse", "HEAD")).toBe(localHead);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sync_branch reports divergence without rewriting local history", async () => {
    const { root, seed, work } = makeRemoteBranchFixture();
    try {
      advanceRemote(seed);
      git(work, "config", "user.name", "Atoma Test");
      git(work, "config", "user.email", "atoma@example.com");
      writeFileSync(join(work, "local.txt"), "local\n");
      git(work, "add", "local.txt");
      git(work, "commit", "-m", "local update");
      const localHead = git(work, "rev-parse", "HEAD");

      const response = await sendRequest(
        "github.ts",
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "sync_branch", arguments: {} } },
        { BRANCH: "atoma/issue-1" },
        work,
      );
      const result = JSON.parse(response.result.content[0].text) as { status: string; ahead: number; behind: number };
      expect(result).toMatchObject({ status: "diverged", ahead: 1, behind: 1 });
      expect(git(work, "rev-parse", "HEAD")).toBe(localHead);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("create_issue rejects malformed gh output", async () => {
    const r = await sendRequest(
      "github.ts",
      {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "create_issue", arguments: { title: "Test", sub_issue: false } },
      },
      {
        PATH: `${FAKE_GH_BIN_DIR}:${process.env.PATH ?? ""}`,
        FAKE_GH_RESPONSES: JSON.stringify([{ match: ["issue", "create"], stdout: "not-a-url" }]),
      },
    );
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("gh issue create: unexpected output");
  });

  test("create_issue provisions the sub-issue label before creating a child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-create-sub-issue-"));
    const log = join(dir, "gh.log");
    try {
      const response = await sendRequest(
        "github.ts",
        {
          jsonrpc: "2.0", id: 4, method: "tools/call",
          params: { name: "create_issue", arguments: { title: "Child task" } },
        },
        {
          PATH: `${FAKE_GH_BIN_DIR}:${process.env.PATH ?? ""}`,
          FAKE_GH_LOG: log,
          FAKE_GH_RESPONSES: JSON.stringify([
            { match: ["label", "create", "atoma/sub-issue"] },
            { match: ["issue", "create"], stdout: "https://github.com/owner/repo/issues/12" },
          ]),
        },
      );
      expect(response.result.isError).toBe(false);
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls[0]).toContain("--force");
      expect(calls[1]).toContain("atoma/sub-issue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The readers built on `gh api` returned the response whole.
   *
   * That is not a small waste. A tool result joins the session on the
   * `atoma-data` branch and is resent on every later inference in it, so an
   * unread field is rent charged for the rest of the issue's life. Measured on
   * this repository before these projections existed: `get_check_runs` returned
   * 24,954 bytes for eight check runs, of which the `app` object was 2,244 bytes
   * PER RUN -- the same GitHub App description eight times -- and `get_branch`
   * returned 11,614 bytes to say a branch exists, 11,164 of it the head commit
   * object nobody asked for.
   *
   * The fixtures below carry the real field names from those payloads, so a
   * rename upstream shows up here rather than as a projection that silently
   * returns nothing.
   */
  describe("projections", () => {
    const call = (name: string, args: Record<string, unknown>, responses: unknown[]) =>
      sendRequest(
        "github.ts",
        { jsonrpc: "2.0", id: 40, method: "tools/call", params: { name, arguments: args } },
        {
          PATH: `${FAKE_GH_BIN_DIR}:${process.env.PATH ?? ""}`,
          FAKE_GH_RESPONSES: JSON.stringify(responses),
        },
      );

    test("get_check_runs keeps what a reader acts on and drops the rest", async () => {
      const payload = {
        check_runs: [
          {
            id: 1,
            name: "atoma-check",
            node_id: "CR_x",
            head_sha: "abc",
            external_id: "e",
            url: "https://api.github.com/x",
            html_url: "https://github.com/owner/repo/actions/runs/1/job/2",
            details_url: "https://github.com/owner/repo/actions/runs/1/job/2",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-01T00:00:00Z",
            completed_at: "2026-01-01T00:01:00Z",
            output: { title: null, summary: null, text: null },
            check_suite: { id: 9 },
            app: { id: 15368, slug: "github-actions", description: "x".repeat(2000) },
            pull_requests: [{ id: 7 }],
          },
        ],
      };
      const r = await call("get_check_runs", { ref: "abc" }, [
        { match: ["check-runs"], stdout: JSON.stringify(payload) },
      ]);
      const runs = JSON.parse(r.result.content[0].text);
      expect(runs).toEqual([
        {
          name: "atoma-check",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/owner/repo/actions/runs/1/job/2",
        },
      ]);
      // The 2KB App description is the whole point of the projection.
      expect(r.result.content[0].text).not.toContain("xxxx");
    });

    test("get_branch answers the question without the head commit object", async () => {
      const payload = {
        name: "main",
        commit: { sha: "deadbeef", commit: { message: "m".repeat(4000) }, author: { login: "a" } },
        _links: { self: "u" },
        protected: true,
        protection: { enabled: true },
        protection_url: "u",
      };
      const r = await call("get_branch", { name: "main" }, [
        { match: ["branches/main"], stdout: JSON.stringify(payload) },
      ]);
      expect(JSON.parse(r.result.content[0].text)).toEqual({ name: "main", sha: "deadbeef", protected: true });
      expect(r.result.content[0].text).not.toContain("mmmm");
    });

    test("get_pr_reviews drops the fields nothing decides on", async () => {
      const payload = {
        reviews: [
          {
            id: "PRR_1",
            author: { login: "reviewer" },
            authorAssociation: "COLLABORATOR",
            body: "looks good",
            submittedAt: "2026-01-01T00:00:00Z",
            includesCreatedEdit: false,
            reactionGroups: [],
            state: "APPROVED",
            commit: { oid: "abc" },
          },
        ],
      };
      const r = await call("get_pr_reviews", { number: 1 }, [
        { match: ["--json", "reviews"], stdout: JSON.stringify(payload) },
      ]);
      expect(JSON.parse(r.result.content[0].text)).toEqual({
        total: 1,
        omitted: 0,
        reviews: [
          { author: { login: "reviewer" }, state: "APPROVED", submittedAt: "2026-01-01T00:00:00Z", body: "looks good" },
        ],
      });
    });

    test("list_pr_review_comments keeps where it is and what it says", async () => {
      const payload = [
        {
          id: 1,
          user: { login: "reviewer", avatar_url: "u", url: "u", html_url: "u", followers_url: "u" },
          path: "src/x.ts",
          line: 42,
          original_line: 40,
          in_reply_to_id: 99,
          diff_hunk: "@@ -1 +1 @@\n-old\n+new",
          body: "rename this",
          author_association: "COLLABORATOR",
        },
      ];
      const r = await call("list_pr_review_comments", { number: 1 }, [
        { match: ["pulls/1/comments"], stdout: JSON.stringify(payload) },
      ]);
      expect(JSON.parse(r.result.content[0].text)).toEqual({
        total: 1,
        omitted: 0,
        comments: [{ author: "reviewer", path: "src/x.ts", line: 42, in_reply_to: 99, body: "rename this" }],
      });
    });

    // A count limit is not a volume limit: the range bounds how MANY comments come
    // back and said nothing about how big one is.
    test("get_issue_comments caps one oversized comment", async () => {
      const body = "y".repeat(40_000);
      const payload = { title: "t", state: "OPEN", comments: [{ author: { login: "a" }, body }] };
      const r = await call("get_issue_comments", { number: 1, from: 1, to: 1 }, [
        { match: ["--json", "comments"], stdout: JSON.stringify(payload) },
      ]);
      const parsed = JSON.parse(r.result.content[0].text);
      expect(parsed.comments[0].body.length).toBeLessThan(body.length);
      expect(parsed.comments[0].body).toContain("characters");
      // And it still says how many there were, which is what stops "not shown"
      // being read as "not there".
      expect(parsed.showing).toBeDefined();
    });
  });

  // The advertised JSON Schema is what teaches the model the correct shape, and
  // zod-to-json-schema is known to degrade silently to `{}` for schemas built
  // the wrong way (see lib/mcp-tool.ts). These assertions pin the emitted schema
  // so a lenient runtime never comes at the cost of a vague contract.
  test("tools/list advertises precise argument schemas", async () => {
    const r = await sendRequest("github.ts", {
      jsonrpc: "2.0", id: 20, method: "tools/list", params: {},
    });
    const byName = new Map<string, any>(r.result.tools.map((t: { name: string }) => [t.name, t]));

    // `.int()` makes zod-to-json-schema emit "integer" rather than "number".
    const getIssue = byName.get("get_issue").inputSchema;
    expect(getIssue.properties.number.type).toBe("integer");
    expect(getIssue.required ?? []).not.toContain("number");

    // Mutations must keep `number` mandatory — no inferring an irreversible target.
    const closeIssue = byName.get("close_issue").inputSchema;
    expect(closeIssue.properties.number.type).toBe("integer");
    expect(closeIssue.required).toContain("number");

    // `labels` stays an array in the contract even though a bare string parses.
    const listIssues = byName.get("list_issues").inputSchema;
    expect(listIssues.properties.labels.type).toBe("array");
    expect(listIssues.properties.labels.items.type).toBe("string");
    expect(listIssues.properties.limit.type).toBe("integer");
  });

  test("get_issue accepts a stringified number", async () => {
    const r = await sendRequest(
      "github.ts",
      {
        jsonrpc: "2.0", id: 21, method: "tools/call",
        params: { name: "get_issue", arguments: { number: "185" } },
      },
      {
        PATH: `${FAKE_GH_BIN_DIR}:${process.env.PATH ?? ""}`,
        FAKE_GH_RESPONSES: JSON.stringify([
          { match: ["issue", "view", "185"], stdout: JSON.stringify({ number: 185, title: "Coerced" }) },
        ]),
      },
    );
    expect(r.result.isError).toBe(false);
    expect(JSON.parse(r.result.content[0].text)).toMatchObject({ number: 185 });
  });

  test("get_issue falls back to the run's issue when number is omitted", async () => {
    const r = await sendRequest(
      "github.ts",
      {
        jsonrpc: "2.0", id: 22, method: "tools/call",
        params: { name: "get_issue", arguments: {} },
      },
      {
        ISSUE_NUMBER: "42",
        PATH: `${FAKE_GH_BIN_DIR}:${process.env.PATH ?? ""}`,
        FAKE_GH_RESPONSES: JSON.stringify([
          { match: ["issue", "view", "42"], stdout: JSON.stringify({ number: 42, title: "From context" }) },
        ]),
      },
    );
    expect(r.result.isError).toBe(false);
    expect(JSON.parse(r.result.content[0].text)).toMatchObject({ number: 42 });
  });

  test("close_issue still refuses an omitted number", async () => {
    const r = await sendRequest(
      "github.ts",
      {
        jsonrpc: "2.0", id: 23, method: "tools/call",
        params: { name: "close_issue", arguments: {} },
      },
      { ISSUE_NUMBER: "42" },
    );
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("Invalid arguments for close_issue");
  });

  test("list_issues accepts a bare string for labels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-list-issues-labels-"));
    const log = join(dir, "gh.log");
    try {
      const r = await sendRequest(
        "github.ts",
        {
          jsonrpc: "2.0", id: 24, method: "tools/call",
          params: { name: "list_issues", arguments: { labels: "atoma/sub-issue", limit: "5" } },
        },
        {
          PATH: `${FAKE_GH_BIN_DIR}:${process.env.PATH ?? ""}`,
          FAKE_GH_LOG: log,
          FAKE_GH_RESPONSES: JSON.stringify([{ match: ["issue", "list"], stdout: "[]" }]),
        },
      );
      expect(r.result.isError).toBe(false);
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      const issueList = calls[0] ?? [];
      expect(issueList).toContain("--label");
      expect(issueList).toContain("atoma/sub-issue");
      // The stringified limit passed validation and reached `gh` as 5.
      expect(issueList[issueList.indexOf("--limit") + 1]).toBe("5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mcp/shell.ts", () => {
  test("executes a foreground command and returns its output", async () => {
    const response = await sendRequest("shell.ts", {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "shell_execute", arguments: { command: "printf hello", timeout_seconds: 5 } },
    });
    const result = JSON.parse(response.result.content[0].text);
    expect(result).toMatchObject({ status: "completed", exit_code: 0, stdout: "hello", stderr: "" });
  });

  // The output goes into the session on the `atoma-data` branch and can be
  // quoted into an issue comment, neither of which GitHub Actions masks. So it
  // has to leave this process already redacted.
  test("keeps a credential in its output from reaching the caller", async () => {
    const response = await sendRequest(
      "shell.ts",
      {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: {
          name: "shell_execute",
          arguments: { command: 'printf "key=$OPENAI_API_KEY shape=ghp_abcdefghijklmnopqrstuvwx"', timeout_seconds: 5 },
        },
      },
      { OPENAI_API_KEY: "sekrit-value-from-the-environment" },
    );
    const result = JSON.parse(response.result.content[0].text);
    expect(result.stdout).toBe("key=[redacted] shape=[redacted]");
  });

  test("terminates commands that exceed their timeout", async () => {
    const response = await sendRequest("shell.ts", {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "shell_execute", arguments: { command: "sleep 2", timeout_seconds: 1 } },
    });
    const result = JSON.parse(response.result.content[0].text);
    expect(result.status).toBe("timeout");
  });
});

describe("mcp/atoma.ts", () => {
  test("initialize returns server info", async () => {
    const r = await sendRequest("atoma.ts", {
      jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS,
    });
    expect(r.result.serverInfo.name).toBe("atoma-mcp-server");
  });

  test("launch_sub_agent schema requires issue and agent", async () => {
    const r = await sendRequest("atoma.ts", {
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    });
    const tool = r.result.tools.find((t: { name: string }) => t.name === "launch_sub_agent");
    expect(tool.inputSchema.required).toEqual(["tasks"]);
    const item = tool.inputSchema.properties.tasks.items;
    expect(item.properties).toHaveProperty("issue");
    expect(item.properties).toHaveProperty("agent");
  });

  test("launch_sub_agent rejects empty tasks", async () => {
    const r = await sendRequest("atoma.ts", {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "launch_sub_agent", arguments: { tasks: [] } },
    });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("tasks must be a non-empty list");
  });
});

// The two servers that had no round-trip test at all.
//
// Worth having on its own, and worth having now in particular: `serveMcpServer`
// replaced five hand-written request handlers with one, and each of those had
// been dropping a different part of a tool's result. `web` is the only server
// whose tools return images, so it is the one place the newly-preserved `images`
// field is exercised -- and it was outside the covered set.
describe("mcp/web.ts", () => {
  test("initializes and advertises fetch", async () => {
    const init = await sendRequest("web.ts", INIT_REQUEST);
    expect(init.result.serverInfo.name).toBe("atoma-web-mcp");

    const list = await sendRequest("web.ts", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("fetch");
  });

  // Not "returns something": returns an ERROR. Every failure here used to come
  // back as an ordinary result whose body happened to be one English sentence,
  // so a model summarising several fetched pages had no structural signal that
  // one of them was never read.
  test("an unreachable host is an error, not a result", async () => {
    const r = await sendRequest("web.ts", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fetch", arguments: { url: "http://127.0.0.1:1/nothing" } },
    });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("127.0.0.1");
  });

  test("a misspelled argument is refused rather than dropped", async () => {
    const r = await sendRequest("web.ts", {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "fetch", arguments: { url: "https://example.com", rawe: true } },
    });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("rawe");
  });

  // This server declares `env: {}` so that it holds no credentials. Accepting
  // any scheme `new URL()` parses made it a local-file read instead -- the
  // cheapest route to `/proc/<pid>/environ` of a server that DOES hold one, and
  // to the `http.extraheader` line `actions/checkout` writes into `.git/config`.
  // No shell command, no routing rule to go around.
  test("refuses a file:// URL, which would make this a local-file read", async () => {
    for (const url of [
      "file:///proc/1/environ",
      "file:///home/runner/work/repo/repo/.git/config",
      "data:text/plain,hello",
    ]) {
      const r = await sendRequest("web.ts", {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "fetch", arguments: { url } },
      });
      expect(r.result.isError, url).toBe(true);
      expect(r.result.content[0].text, url).toContain("http");
    }
  });
});

// `search.ts` is deliberately NOT round-tripped here.
//
// It imports `@huggingface/transformers` at module scope, and on a CI runner
// that import does not finish inside sixty seconds -- measured, not guessed:
// the whole check went from 42s to 3m28s and still timed out. Raising the
// timeout further would buy a smoke test for one server at the cost of minutes
// on every run of the suite.
//
// What such a test would cover is `serveMcpServer`, and the four servers above
// cover it: `search.ts` calls it with the same arguments in the same shape. Its
// own logic -- ranking, chunk selection, the current-issue filter -- is pure and
// lives in `domain/bm25.ts`, which is tested directly.
//
// Written down rather than left as an absence, because a server missing from a
// list of five reads as an oversight, and this one is a decision. If the import
// ever becomes lazy, this is the note to delete.

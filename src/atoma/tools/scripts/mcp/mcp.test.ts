import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS_DIR = join(process.cwd(), "src/atoma/tools/scripts/mcp");
const FAKE_GH_BIN_DIR = join(process.cwd(), "src/scripts/testing/bin");

function sendRequest(
  script: string,
  request: Record<string, unknown>,
  env: Record<string, string> = {},
  cwd = process.cwd(),
  extraArgs: string[] = [],
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
    }, 5000);
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

/**
 * Send an initialize handshake followed by a second request (e.g. tools/call)
 * to a McpServer-based script.  McpServer requires initialization before
 * accepting tool calls, unlike the lower-level Server class.
 *
 * Returns the response whose `id` matches `secondRequest.id`.
 */
function sendRequestWithInit(
  script: string,
  secondRequest: Record<string, unknown>,
  env: Record<string, string> = {},
  cwd = process.cwd(),
  extraArgs: string[] = [],
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", `${SCRIPTS_DIR}/${script}`, ...extraArgs], {
      env: { ...process.env, GITHUB_REPOSITORY: "owner/repo", ...env },
      cwd,
    });
    let out = "";
    let initialized = false;
    const targetId = secondRequest.id;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for response from ${script}`));
    }, 8000);
    child.stdout.on("data", (d) => {
      out += d.toString();
      const lines = out.split("\n").filter((l) => l.trim());
      if (!initialized && lines.length >= 1) {
        // Got the initialize response; send initialized notification then the second request
        initialized = true;
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
        child.stdin.write(JSON.stringify(secondRequest) + "\n");
      }
      if (initialized) {
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.id === targetId) {
              clearTimeout(timer);
              child.kill();
              resolve(parsed);
              return;
            }
          } catch {
            // skip non-JSON lines
          }
        }
      }
    });
    child.stdin.write(JSON.stringify(INIT_REQUEST) + "\n");
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

  test("terminates commands that exceed their timeout", async () => {
    const response = await sendRequest("shell.ts", {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "shell_execute", arguments: { command: "sleep 2", timeout_seconds: 1 } },
    });
    const result = JSON.parse(response.result.content[0].text);
    expect(result.status).toBe("timeout");
  });
});

describe("mcp/filesystem.ts", () => {
  test("initialize returns server info", async () => {
    const r = await sendRequest("filesystem.ts", {
      jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS,
    }, {}, process.cwd(), ["."]);
    expect(r.result.serverInfo.name).toBe("secure-filesystem-server");
  });

  test("tools/list exposes read-only filesystem tools", async () => {
    const r = await sendRequestWithInit(
      "filesystem.ts",
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {}, process.cwd(), ["."]
    );
    const names = r.result.tools.map((t: { name: string }) => t.name);
    for (const tool of ["read_file", "read_text_file", "list_directory", "get_file_info"]) {
      expect(names).toContain(tool);
    }
  });

  test("list_directory returns entries", async () => {
    const dir = mkdtempSync(join(process.cwd(), "atoma-fs-list-"));
    writeFileSync(join(dir, "hello.txt"), "hi\n");
    try {
      const r = await sendRequestWithInit(
        "filesystem.ts",
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_directory", arguments: { path: dir } } },
        {}, process.cwd(), ["."]
      );
      expect(r.result.isError ?? false).toBe(false);
      expect(r.result.content[0].text).toContain("hello.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read_text_file returns file contents", async () => {
    const dir = mkdtempSync(join(process.cwd(), "atoma-fs-read-"));
    const filePath = join(dir, "data.txt");
    writeFileSync(filePath, "hello from bundle\n");
    try {
      const r = await sendRequestWithInit(
        "filesystem.ts",
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_text_file", arguments: { path: filePath } } },
        {}, process.cwd(), ["."]
      );
      expect(r.result.isError ?? false).toBe(false);
      expect(r.result.content[0].text).toContain("hello from bundle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

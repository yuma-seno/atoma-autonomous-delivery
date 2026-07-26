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
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", `${SCRIPTS_DIR}/${script}`], {
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

const INIT_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test-client", version: "1.0.0" },
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

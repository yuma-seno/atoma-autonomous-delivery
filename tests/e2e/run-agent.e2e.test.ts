/**
 * run-agent.e2e.test.ts — real end-to-end test: the actual `atoma` binary,
 * running its real inference loop and real MCP client, driven against:
 *   - a local mock OpenAI-compatible HTTP server (mock-llm-server.ts) that
 *     returns scripted responses, so no real LLM API call is made;
 *   - the REAL, compiled `dist/.github/atoma/tools/scripts/mcp/github.ts`
 *     MCP server, spawned exactly like production does (via `bun run`),
 *     communicating over real stdio JSON-RPC;
 *   - a fake `gh` CLI stub (fake-gh.ts, reusing src/scripts/testing/bin/gh)
 *     so mcp/github.ts's real business logic runs without hitting the real
 *     GitHub API.
 *
 * This is one of the only places in the test suite that exercises the real
 * agent-loop <-> MCP-protocol <-> script boundary end-to-end (see also
 * launch-sub-agent.e2e.test.ts); everything else (scripts.test.ts,
 * mcp.test.ts, shell_guard.test.ts) tests one layer at a time. It
 * intentionally lives outside `bun run test`'s default paths (see
 * package.json's "test" vs "test:e2e" scripts) since it requires a
 * pre-built `atoma` binary and is slower -- run manually with
 * `bun run test:e2e` after `cargo build` in the sibling `atoma` repo. The
 * whole suite is skipped (not failed) when the binary can't be found.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFakeGh } from "./fake-gh.ts";
import { startMockLlmServer } from "./mock-llm-server.ts";
import { atomaAvailable, REPO_ROOT, runAtoma } from "./run-atoma.ts";

const GITHUB_MCP_SCRIPT = join(REPO_ROOT, "dist/.github/atoma/tools/scripts/mcp/github.ts");
const SHELL_MCP_SCRIPT = join(REPO_ROOT, "dist/.github/atoma/tools/scripts/mcp/shell.ts");
const PROMPT_TEMPLATE = join(REPO_ROOT, "dist/.github/atoma/prompt-template.md");
const SKILLS_DIR = join(REPO_ROOT, "dist/.github/atoma/skills");

describe.skipIf(!atomaAvailable)("E2E: real atoma binary + real mcp/github.ts", () => {
  test("agent executes a command through the real shell MCP server", async () => {
    const mock = startMockLlmServer([
      {
        toolCalls: [{
          id: "shell_1",
          name: "shell__shell_execute",
          arguments: { command: "printf shell-ok", execution_mode: "foreground", timeout_seconds: 5 },
        }],
      },
      { content: "Done: shell command completed." },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "atoma-shell-e2e-"));
    try {
      writeFileSync(
        join(dir, "agent.md"),
        `---
name: e2e-shell-agent
description: Minimal shell agent for E2E testing.
model: test-model
provider: openai
mcp_servers: ["shell"]
---
You are a test agent.
`,
      );
      writeFileSync(
        join(dir, "tools.yaml"),
        `shell:
  command: bun
  args: ["run", "${SHELL_MCP_SCRIPT}"]
`,
      );
      writeFileSync(join(dir, "prompt.txt"), "Run the test command.");

      const { exitCode, stderr } = await runAtoma({
        agentDefPath: join(dir, "agent.md"),
        toolsFilePath: join(dir, "tools.yaml"),
        promptFilePath: join(dir, "prompt.txt"),
        outSessionPath: join(dir, "session.json"),
        env: {
          OPENAI_BASE_URL: mock.url,
          OPENAI_API_KEY: "dummy-test-key",
          ATOMA_PROVIDER: "openai",
        },
      });

      if (exitCode !== 0) console.error("atoma stderr:", stderr);
      expect(exitCode).toBe(0);
      const toolMessage = mock.requests[1]!.messages.find((message) => message.role === "tool");
      const result = JSON.parse(String(toolMessage?.content));
      expect(result).toMatchObject({ status: "completed", exit_code: 0, stdout: "shell-ok" });
    } finally {
      mock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("agent calls github__get_issue through the real MCP server", async () => {
    const mock = startMockLlmServer([
      { toolCalls: [{ id: "call_1", name: "github__get_issue", arguments: { number: 42 } }] },
      { content: "Done: fetched issue #42." },
    ]);
    const fakeGh = setupFakeGh([
      {
        match: ["issue", "view"],
        stdout: JSON.stringify({
          number: 42,
          title: "Fake issue #42",
          body: "This is a fake issue body for E2E testing.",
          state: "OPEN",
          labels: [],
          createdAt: "2026-01-01T00:00:00Z",
          closedAt: null,
          comments: [],
        }),
      },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "atoma-e2e-"));
    try {
      writeFileSync(
        join(dir, "agent.md"),
        `---
name: e2e-test-agent
description: Minimal agent for E2E testing.
model: test-model
provider: openai
mcp_servers: ["github"]
---
You are a test agent.
`,
      );

      writeFileSync(
        join(dir, "tools.yaml"),
        `github:
  command: bun
  args: ["run", "${GITHUB_MCP_SCRIPT}"]
`,
      );

      writeFileSync(join(dir, "prompt.txt"), "Please fetch issue #42.");

      const { exitCode, stderr } = await runAtoma({
        agentDefPath: join(dir, "agent.md"),
        toolsFilePath: join(dir, "tools.yaml"),
        promptFilePath: join(dir, "prompt.txt"),
        outSessionPath: join(dir, "session.json"),
        env: {
          ...fakeGh.env,
          GITHUB_REPOSITORY: "owner/repo",
          ATOMA_OPS_LOG: join(dir, "ops.log"),
          OPENAI_BASE_URL: mock.url,
          OPENAI_API_KEY: "dummy-test-key",
          ATOMA_PROVIDER: "openai",
        },
      });

      if (exitCode !== 0) {
        console.error("atoma stderr:", stderr);
      }
      expect(exitCode).toBe(0);

      // Prove the REAL MCP server actually ran: the second LLM request must
      // carry a "tool" role message whose content is the real getIssue()
      // response text (built from mcp/github.ts + lib/gh.ts + fake gh),
      // not anything this test hardcoded.
      expect(mock.requests.length).toBeGreaterThanOrEqual(2);
      const secondRequestMessages = mock.requests[1]!.messages;
      const toolMessage = secondRequestMessages.find((m) => m.role === "tool");
      expect(String(toolMessage?.content)).toContain("Fake issue #42");
      expect(fakeGh.calls().some((c) => c.includes("view"))).toBe(true);
    } finally {
      mock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("agent dynamically loads a built-in skill into ordinary tool history", async () => {
    const mock = startMockLlmServer([
      {
        toolCalls: [
          {
            id: "skill_1",
            name: "atoma_builtin__load_skill",
            arguments: { name: "engineering/tdd" },
          },
        ],
      },
      { content: "Done: applied the TDD skill." },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "atoma-skill-e2e-"));
    try {
      writeFileSync(
        join(dir, "agent.md"),
        `---
name: e2e-skill-agent
description: Minimal skill-loading agent for E2E testing.
model: test-model
provider: openai
---
You are a test agent.
`,
      );
      writeFileSync(join(dir, "tools.yaml"), "{}\n");
      writeFileSync(join(dir, "prompt.txt"), "Use the TDD skill.");

      const { exitCode, stderr } = await runAtoma({
        agentDefPath: join(dir, "agent.md"),
        toolsFilePath: join(dir, "tools.yaml"),
        templatePath: PROMPT_TEMPLATE,
        skillsDir: SKILLS_DIR,
        promptFilePath: join(dir, "prompt.txt"),
        outSessionPath: join(dir, "session.json"),
        env: {
          OPENAI_BASE_URL: mock.url,
          OPENAI_API_KEY: "dummy-test-key",
          ATOMA_PROVIDER: "openai",
        },
      });

      if (exitCode !== 0) console.error("atoma stderr:", stderr);
      expect(exitCode).toBe(0);
      expect(mock.requests[0]!.tools?.some((tool) => tool.function?.name === "atoma_builtin__load_skill")).toBe(true);
      const initialPrompt = String(mock.requests[0]!.messages[0]?.content);
      expect(initialPrompt).toContain("Load each relevant skill with `atoma_builtin__load_skill`");
      expect(initialPrompt).toContain("`engineering/tdd`");

      const toolMessage = mock.requests[1]!.messages.find((message) => message.role === "tool");
      expect(String(toolMessage?.content)).toContain("# Skill: engineering/tdd");
      expect(String(toolMessage?.content)).toContain("Add or select one focused test");
    } finally {
      mock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});


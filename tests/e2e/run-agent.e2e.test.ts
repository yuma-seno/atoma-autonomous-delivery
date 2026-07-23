/**
 * run-agent.e2e.test.ts — real end-to-end test: the actual `atoma` binary
 * (built from the sibling `atoma` repo), running its real inference loop
 * and real MCP client, driven against:
 *   - a local mock OpenAI-compatible HTTP server (mock-llm-server.ts) that
 *     returns scripted responses, so no real LLM API call is made;
 *   - the REAL, compiled `dist/.github/atoma/tools/scripts/mcp/github.ts`
 *     MCP server, spawned exactly like production does (via `bun run`),
 *     communicating over real stdio JSON-RPC;
 *   - a fake `gh` CLI stub (fixtures/bin/gh) prepended to PATH, so
 *     mcp/github.ts's real business logic runs without hitting the real
 *     GitHub API.
 *
 * This is the only place in the test suite that exercises the real
 * agent-loop <-> MCP-protocol <-> script boundary end-to-end; everything
 * else (scripts.test.ts, mcp.test.ts, shell_guard.test.ts) tests one layer
 * at a time. It intentionally lives outside `bun run test`'s default paths
 * (see package.json's "test" vs "test:e2e" scripts) since it requires a
 * pre-built `atoma` binary and is slower -- run manually with
 * `bun run test:e2e` after `cargo build` in the sibling `atoma` repo.
 *
 * ATOMA_BIN env var overrides the default sibling-checkout path
 * (../atoma/target/debug/atoma, relative to this repo's root). The whole
 * suite is skipped (not failed) when the binary can't be found, since this
 * is an opt-in local/manual check, not part of the CI gate.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLlmServer } from "./mock-llm-server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const GITHUB_MCP_SCRIPT = join(REPO_ROOT, "dist/.github/atoma/tools/scripts/mcp/github.ts");
const FAKE_BIN_DIR = join(HERE, "fixtures/bin");

const ATOMA_BIN = process.env.ATOMA_BIN ?? join(REPO_ROOT, "..", "atoma/target/debug/atoma");
const atomaAvailable = existsSync(ATOMA_BIN);

describe.skipIf(!atomaAvailable)("E2E: real atoma binary + real mcp/github.ts", () => {
  test("agent calls github__get_issue through the real MCP server", async () => {
    const mock = startMockLlmServer([
      { toolCalls: [{ id: "call_1", name: "github__get_issue", arguments: { number: 42 } }] },
      { content: "Done: fetched issue #42." },
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
  env:
    PATH: "${FAKE_BIN_DIR}:${process.env.PATH}"
    GITHUB_REPOSITORY: "owner/repo"
    ATOMA_OPS_LOG: "${join(dir, "ops.log")}"
`,
      );

      writeFileSync(join(dir, "prompt.txt"), "Please fetch issue #42.");

      const outSession = join(dir, "session.json");

      // Bun.spawn (async), NOT spawnSync: spawnSync blocks this whole JS
      // thread until the child exits, which would starve the event loop
      // that mock.url's Bun.serve() needs in order to answer the atoma
      // binary's HTTP requests -- a deadlock, since the atoma process
      // would then be waiting forever for an LLM response that never gets
      // handled.
      const proc = Bun.spawn({
        cmd: [
          ATOMA_BIN,
          "run",
          "--agent-def",
          join(dir, "agent.md"),
          "--tools-file",
          join(dir, "tools.yaml"),
          "--prompt-file",
          join(dir, "prompt.txt"),
          "--out-session",
          outSession,
          "--max-iterations",
          "5",
        ],
        env: {
          ...process.env,
          OPENAI_BASE_URL: mock.url,
          OPENAI_API_KEY: "dummy-test-key",
          ATOMA_PROVIDER: "openai",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

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
    } finally {
      mock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

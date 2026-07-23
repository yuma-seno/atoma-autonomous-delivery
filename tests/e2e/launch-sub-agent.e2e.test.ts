/**
 * launch-sub-agent.e2e.test.ts — real end-to-end test for the
 * `atoma__launch_sub_agent` tool: the actual `atoma` binary, its real
 * inference loop and real MCP client, driven against the REAL, compiled
 * `dist/.github/atoma/tools/scripts/mcp/atoma.ts` MCP server over real
 * stdio JSON-RPC, with a fake `gh` CLI so the real dispatch chain
 * (mcp/atoma.ts -> launch_sub_agent.ts -> get_config_value.ts -> gh)
 * runs without touching the real GitHub API or triggering a real
 * `gh workflow run`.
 *
 * See run-agent.e2e.test.ts for the general design notes (mock LLM server,
 * why this suite is opt-in/skipped without a pre-built atoma binary, etc.).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFakeGh } from "./fake-gh.ts";
import { startMockLlmServer } from "./mock-llm-server.ts";
import { atomaAvailable, REPO_ROOT, runAtoma } from "./run-atoma.ts";

const ATOMA_MCP_SCRIPT = join(REPO_ROOT, "dist/.github/atoma/tools/scripts/mcp/atoma.ts");

describe.skipIf(!atomaAvailable)("E2E: real atoma binary + real mcp/atoma.ts", () => {
  test("agent calls atoma__launch_sub_agent through the real MCP server", async () => {
    const mock = startMockLlmServer([
      {
        toolCalls: [
          { id: "call_1", name: "atoma__launch_sub_agent", arguments: { tasks: [{ issue: 7, agent: "engineer" }] } },
        ],
      },
    ]);
    // Real invocations the real dispatch chain makes, in order:
    //   1. launch_sub_agent.ts: `gh issue comment 7 --body ...`
    //   2. launch_sub_agent.ts spawns get_config_value.ts (no `gh` call --
    //      reads .github/atoma/config.json directly, resolved relative to
    //      the atoma binary's own cwd, which is this repo's checkout root).
    //   3. launch_sub_agent.ts: `gh issue edit 7 --add-label atoma/launched`
    //   4. launch_sub_agent.ts: `gh workflow run atoma-runner.yml ...`
    const fakeGh = setupFakeGh([
      { match: ["issue", "comment"] },
      { match: ["issue", "edit"] },
      { match: ["workflow", "run"] },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "atoma-e2e-"));
    try {
      writeFileSync(
        join(dir, "agent.md"),
        `---
name: e2e-test-orchestrator
description: Minimal orchestrator agent for E2E testing.
model: test-model
provider: openai
mcp_servers: ["atoma"]
---
You are a test orchestrator agent.
`,
      );

      writeFileSync(
        join(dir, "tools.yaml"),
        `atoma:
  command: bun
  args: ["run", "${ATOMA_MCP_SCRIPT}"]
`,
      );

      writeFileSync(join(dir, "prompt.txt"), "Please dispatch an engineer on sub-issue #7.");

      const { exitCode, stderr } = await runAtoma({
        agentDefPath: join(dir, "agent.md"),
        toolsFilePath: join(dir, "tools.yaml"),
        promptFilePath: join(dir, "prompt.txt"),
        outSessionPath: join(dir, "session.json"),
        env: {
          ...fakeGh.env,
          // launch_sub_agent.ts resolves .github/atoma/tools/scripts/get_config_value.ts
          // and .github/atoma/config.json relative to cwd -- both spawned
          // without an explicit cwd override, so they inherit whatever cwd
          // this test itself runs with (this repo's checkout root, which
          // already has a real, CI-synced .github/ copy of dist/.github/).
          OPENAI_BASE_URL: mock.url,
          OPENAI_API_KEY: "dummy-test-key",
          ATOMA_PROVIDER: "openai",
        },
      });

      if (exitCode !== 0) {
        console.error("atoma stderr:", stderr);
      }
      expect(exitCode).toBe(0);

      // Prove the REAL dispatch chain actually ran: a comment was posted
      // mentioning the dispatched agent, the sub-issue got labeled
      // "launched" (proving get_config_value.ts's own real config.json
      // lookup ran), and the runner workflow was dispatched for the right
      // agent/issue -- none of this is hardcoded by this test.
      const calls = fakeGh.calls();
      const commentCall = calls.find((c) => c.includes("comment"));
      expect(commentCall?.join(" ")).toContain("engineer");
      const editCall = calls.find((c) => c.includes("edit"));
      expect(editCall).toContain("atoma/launched");
      const workflowCall = calls.find((c) => c[0] === "workflow" && c[1] === "run");
      expect(workflowCall?.join(" ")).toContain("agent=engineer");
      expect(workflowCall?.join(" ")).toContain("number=7");

      // launch_sub_agent's real response sets _meta.session_ends: true (it
      // ends the orchestrator session immediately, by design -- see
      // mcp/atoma.ts's doc comment), so the atoma binary should NOT loop
      // back to the LLM for a second turn; only the one request is made.
      expect(mock.requests.length).toBe(1);
      const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as {
        messages: { role: string; content: string }[];
      };
      const toolMessage = session.messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("dispatched");
    } finally {
      mock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * request-close-issue.e2e.test.ts — real end-to-end test for the
 * `atoma__request_close_issue` tool's human-authored-issue path: the actual
 * `atoma` binary, its real inference loop and real MCP client, against the
 * REAL, compiled `dist/.github/atoma/tools/scripts/mcp/atoma.ts` MCP server,
 * with a fake `gh` CLI so the real chain (mcp/atoma.ts ->
 * concludeIssue -> lib/notify.ts's resolveNotify() -> gh) runs
 * without touching the real GitHub API.
 *
 * Covers only the human-authored branch (escalate via comment, do NOT
 * close): the bot-authored branch additionally cascades into
 * lib/aggregation.ts's `dispatchOrchestratorIfSubIssueReady()` (its own
 * retry/sibling-check logic), which would need its own dedicated fixture --
 * left as a further opportunity, not implemented here (see
 * run-agent.e2e.test.ts for the general design).
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
  test("agent calls atoma__request_close_issue for a human-authored issue", async () => {
    const mock = startMockLlmServer([
      { toolCalls: [{ id: "call_1", name: "atoma__request_close_issue", arguments: { reason: "All done", summary: "Shipped it." } }] },
    ]);
    const fakeGh = setupFakeGh([
      // concludeIssue: `gh issue view 99 --repo ... --json author`
      { match: ["issue", "view"], stdout: JSON.stringify({ author: { id: "1", is_bot: false, login: "alice", name: "Alice" } }) },
      // resolveNotify: `gh api repos/.../issues/99 --jq ...`
      { match: ["issues/99"], stdout: JSON.stringify({ body: "no tag", login: "alice", type: "User" }) },
      { match: ["issue", "comment"] },
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

      writeFileSync(join(dir, "prompt.txt"), "Please conclude this issue.");

      const { exitCode, stderr } = await runAtoma({
        agentDefPath: join(dir, "agent.md"),
        toolsFilePath: join(dir, "tools.yaml"),
        promptFilePath: join(dir, "prompt.txt"),
        outSessionPath: join(dir, "session.json"),
        env: {
          ...fakeGh.env,
          GITHUB_REPOSITORY: "owner/repo",
          ISSUE_NUMBER: "99",
          OPENAI_BASE_URL: mock.url,
          OPENAI_API_KEY: "dummy-test-key",
          ATOMA_PROVIDER: "openai",
        },
      });

      if (exitCode !== 0) {
        console.error("atoma stderr:", stderr);
      }
      expect(exitCode).toBe(0);

      // Prove the REAL chain ran: a comment was posted mentioning the
      // resolved human author, WITHOUT closing the issue (no `gh issue
      // close` call), and the tool's real (not hardcoded) response text
      // made it into the session.
      const calls = fakeGh.calls();
      expect(calls.some((c) => c[0] === "issue" && c[1] === "close")).toBe(false);
      const commentCall = calls.find((c) => c.includes("comment"));
      expect(commentCall?.join(" ")).toContain("@alice");
      expect(commentCall?.join(" ")).toContain("All done");

      const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as {
        messages: { role: string; content: string }[];
      };
      const toolMessage = session.messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("opened directly by a human");
    } finally {
      mock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

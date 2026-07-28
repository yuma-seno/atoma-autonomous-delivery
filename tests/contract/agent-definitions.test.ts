/**
 * agent-definitions.test.ts — consistency between the agent definitions and
 * the tool servers they declare.
 *
 * Atoma resolves every name in an agent's `mcp_servers` against `tools.yaml`
 * and aborts the whole run if one is missing, before a single MCP server
 * starts. That failure is invisible to typecheck, to `synth`, and to any test
 * that exercises one agent at a time.
 *
 * It has already happened once: an agent inspected only its own tool surface,
 * concluded the non-readonly `filesystem` server was unused, and removed it —
 * while `engineer.md` still depended on it for every write operation. Nothing
 * in the pipeline objected, so it merged and broke the engineer.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR = join(process.cwd(), "src/atoma/agent-definitions");
const TOOLS_YAML = join(process.cwd(), "src/atoma/tools/tools.yaml");

/** Top-level (unindented) keys of tools.yaml — one per MCP server. */
function declaredServers(): Set<string> {
  const yaml = readFileSync(TOOLS_YAML, "utf8");
  const names = new Set<string>();
  for (const line of yaml.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/** `mcp_servers` entries from one agent definition's YAML frontmatter. */
function requestedServers(agentFile: string): string[] {
  const lines = readFileSync(join(AGENT_DIR, agentFile), "utf8").split(/\r?\n/);
  const start = lines.indexOf("mcp_servers:");
  if (start === -1) return [];

  const servers: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (!match?.[1]) break; // first non-list line ends the block
    servers.push(match[1]);
  }
  return servers;
}

const agentFiles = readdirSync(AGENT_DIR).filter((f) => f.endsWith(".md"));

describe("agent definitions", () => {
  test("the fixture set is non-empty", () => {
    expect(agentFiles.length).toBeGreaterThan(0);
    expect(declaredServers().size).toBeGreaterThan(0);
  });

  test.each(agentFiles)("%s declares only servers that tools.yaml defines", (agentFile) => {
    const available = declaredServers();
    const requested = requestedServers(agentFile);

    expect(requested.length).toBeGreaterThan(0);
    for (const server of requested) {
      expect(
        available.has(server),
        `${agentFile} lists mcp_servers "${server}", which tools.yaml does not define. ` +
          `Atoma aborts the run on this. Available: ${[...available].sort().join(", ")}`,
      ).toBe(true);
    }
  });
});

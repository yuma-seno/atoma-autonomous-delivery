import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * `tools.yaml` decides how every tool server is started, and nothing was reading
 * it as YAML.
 *
 * Three tests already touch the file and all three use regular expressions: one
 * counts `command:` lines, one greps for a machinery prefix, one checks a hook
 * path. A malformed flow sequence would satisfy every one of them and then fail
 * at run time, where the symptom is that no agent can start at all — and this
 * repository has no way to run atoma before CI, so the first execution IS
 * production.
 *
 * The `shell` entry is what made this worth writing. Its `args` was a
 * twenty-line flow sequence for a container invocation, hand-written; #464 reduced
 * it to a plain `bun run`, and the test that pinned the container is now the test
 * that keeps one from coming back.
 */
const SOURCE = "src/atoma/tools/tools.yaml";
const DEPLOYED = "dist/.github/atoma/tools/tools.yaml";

interface ToolEntry {
  command?: string;
  args?: unknown;
  env?: Record<string, string>;
  hooks?: { before_tool?: string; tool_allowlist?: string[]; tool_denylist?: string[] };
}

function parse(path: string): Record<string, ToolEntry> {
  return Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, ToolEntry>;
}

describe("tools.yaml is valid YAML with the shape atoma expects", () => {
  for (const path of [SOURCE, DEPLOYED]) {
    test(`${path} parses`, () => {
      const tools = parse(path);
      expect(Object.keys(tools).length).toBeGreaterThan(4);
    });

    test(`${path}: every entry has a command and a string[] args`, () => {
      for (const [name, entry] of Object.entries(parse(path))) {
        expect(typeof entry.command, `${name}.command`).toBe("string");
        expect(Array.isArray(entry.args), `${name}.args must be a list`).toBe(true);
        for (const arg of entry.args as unknown[]) {
          expect(typeof arg, `${name}.args entries must all be strings`).toBe("string");
        }
      }
    });

    /**
     * The shell server is started plainly, and that is now the property to defend.
     *
     * It ran in a rootless podman container until #464: twenty-five lines of argv,
     * an overlay of $HOME, a generated /etc/passwd and subordinate id ranges. The
     * container bought secrecy by giving the shell a different filesystem from
     * every other tool, and a write to $HOME there succeeded and then was not
     * there for anything else -- silent, and measured in 18 of 2,118 shell calls.
     *
     * Isolation now comes from the OS user every server runs as, arranged by the
     * runner, not from anything in this file. So a container reappearing here
     * would reintroduce the divergence without saying so, which is what this test
     * is for.
     */
    test(`${path}: the shell server is started plainly, with no container`, () => {
      const shell = parse(path).shell;
      expect(shell?.command, "the shell server must be started directly").toBe("bun");
      const args = (shell?.args ?? []) as string[];
      expect(args[0]).toBe("run");
      expect(args.at(-1)).toContain("mcp/shell.ts");
      // Named individually rather than as "no flags": each one is a mechanism that
      // would put the shell somewhere the other tools are not.
      for (const forbidden of ["podman", "docker", "--user", "-v", "unshare", "chroot", "sudo"]) {
        expect(args, `${path}: shell args must not contain ${forbidden}`).not.toContain(forbidden);
      }
    });
  }

  // Credentials reach a server by being named in its own `env`. The confined
  // server naming one would defeat the point of confining it.
  test("the shell server declares no credentials", () => {
    expect(parse(SOURCE).shell?.env ?? {}).toEqual({});
  });
});

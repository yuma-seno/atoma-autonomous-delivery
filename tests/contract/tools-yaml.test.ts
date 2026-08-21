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
  request_timeout_secs?: number;
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

  /**
   * A tool that promises the agent a long timeout must have a server entry that
   * allows it.
   *
   * `shell_execute` accepts `timeout_seconds` up to 3600 and defaults to 300.
   * atoma caps every `tools/call` at 60 seconds unless the server says otherwise,
   * and nothing connected the two -- so every value above 60 was a promise this
   * file quietly broke. A build or a test suite running over a minute failed, and
   * the error named the shell server rather than the client that gave up.
   *
   * Read out of shell.ts rather than written down here, because the number that
   * matters is the one the agent is told, and that is the one in the schema.
   */
  test("a tool that advertises a long timeout has a server entry that allows it", () => {
    const source = readFileSync("src/atoma/tools/scripts/mcp/shell.ts", "utf8");
    const advertised = source.match(/timeout_seconds:[^\n]*?\.max\((\d+)\)/);
    expect(advertised, "shell.ts must still declare a max for timeout_seconds").not.toBeNull();
    const seconds = Number(advertised![1]);

    for (const path of [SOURCE, DEPLOYED]) {
      const declared = parse(path).shell?.request_timeout_secs;
      expect(declared, `${path}: shell must declare request_timeout_secs`).toBeDefined();
      expect(
        declared,
        `${path}: shell_execute offers timeout_seconds up to ${seconds}, so atoma must allow at least that long`,
      ).toBeGreaterThanOrEqual(seconds);
    }
  });

  /**
   * The search server needs longer than the default too, for a different reason:
   * its reranker is a 544MB ONNX file that took 63.9s to load against atoma's 60s
   * limit, so the first search of every run failed and the answer arrived fifteen
   * seconds after nobody was waiting for it.
   *
   * The server now begins that load at startup instead of on the first call, which
   * absorbs most of it -- but "most" is not "all" on a slow network, and the load
   * is what this value covers.
   */
  test("the search server allows for loading its model", () => {
    for (const path of [SOURCE, DEPLOYED]) {
      const declared = parse(path).search?.request_timeout_secs ?? 0;
      expect(
        declared,
        `${path}: the reranker load was measured at 63.9s, so 60 is not enough`,
      ).toBeGreaterThan(64);
    }
  });

  /**
   * And nothing else raises it, because raising it costs something.
   *
   * The request timeout is the only thing that notices a server which has stopped
   * responding. A server that answers from memory or from one HTTP call should
   * keep the short default, so a hung one is reported in a minute rather than in
   * however long someone felt generous.
   */
  test("only the servers that need a longer timeout have one", () => {
    const allowed = new Set(["shell", "search"]);
    for (const [name, entry] of Object.entries(parse(SOURCE))) {
      if (entry.request_timeout_secs === undefined) continue;
      expect(
        allowed.has(name),
        `${name} raises request_timeout_secs; if its work genuinely takes minutes, add it here and say why`,
      ).toBe(true);
    }
  });
});

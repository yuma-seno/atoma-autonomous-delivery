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
 * The `shell` entry is what made this worth writing: its `args` is a
 * twenty-line flow sequence for a container invocation, hand-written.
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

    // The confinement in #374 is expressed entirely in this file. If any of these
    // is dropped the server still starts -- and silently stops being confined,
    // which is the failure mode the whole design exists to avoid.
    test(`${path}: the shell server is still confined`, () => {
      const args = (parse(path).shell?.args ?? []) as string[];
      const joined = args.join(" ");
      expect(parse(path).shell?.command).toBe("podman");

      // NOT uid 0: rootless podman maps container uid 0 to the host user, which
      // would put this container's environment back within reach.
      expect(args).toContain("--user");
      expect(joined).not.toMatch(/--user 0[: ]/);

      // The host toolchain, read-only. Read-only is what stops PATH poisoning,
      // since /usr/local/bin is world-writable on a runner.
      for (const mount of ["/usr:/usr:ro", "/opt:/opt:ro", "/etc:/etc:ro"]) {
        expect(joined, `missing read-only mount ${mount}`).toContain(mount);
      }

      // The overlay is what makes $HOME readable, writable, and harmless at once.
      expect(joined).toContain("/home/runner");

      // With the docker socket the container reads a host process's environ
      // through --pid=host, and the confinement is worth nothing.
      expect(joined, "the docker socket must never be mounted here").not.toContain("docker.sock");
      expect(args, "privileged would undo all of it").not.toContain("--privileged");
      expect(joined, "the host PID namespace would undo all of it").not.toContain("pid=host");
    });
  }

  // Credentials reach a server by being named in its own `env`. The confined
  // server naming one would defeat the point of confining it.
  test("the shell server declares no credentials", () => {
    expect(parse(SOURCE).shell?.env ?? {}).toEqual({});
  });
});

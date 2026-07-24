import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const SCRIPT = "src/atoma/tools/scripts/hooks/shell_guard.ts";

describe("shell_guard.ts", () => {
  test("blocks dangerous commands", () => {
    const r = spawnSync("bun", ["run", SCRIPT], {
      input: JSON.stringify({ arguments: { command: "gh issue list" } }),
      encoding: "utf8",
    });
    expect(r.stdout).toContain('"allow":false');
  });

  test("allows safe commands", () => {
    const r = spawnSync("bun", ["run", SCRIPT], {
      input: JSON.stringify({ arguments: { command: "ls -la" } }),
      encoding: "utf8",
    });
    expect(r.stdout).toContain('"allow":true');
  });

  test("blocks backslash-obfuscated dangerous commands", () => {
    const r = spawnSync("bun", ["run", SCRIPT], {
      input: JSON.stringify({ arguments: { command: "w\\get --version" } }),
      encoding: "utf8",
    });
    expect(r.stdout).toContain('"allow":false');
  });

  test("blocks quote-spliced dangerous commands", () => {
    const r = spawnSync("bun", ["run", SCRIPT], {
      input: JSON.stringify({ arguments: { command: 'cu""rl example.com' } }),
      encoding: "utf8",
    });
    expect(r.stdout).toContain('"allow":false');
  });
});

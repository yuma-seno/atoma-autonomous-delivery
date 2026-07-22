import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const SCRIPT = "dist/.github/atoma/tools/scripts/hooks/shell_guard.ts";

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
});

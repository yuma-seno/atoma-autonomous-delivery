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

  test("blocks raw Git mutations while allowing read-only Git inspection", () => {
    for (const command of [
      "git push origin main --force",
      "cd repo && git pull --rebase origin main",
      "git -C repo checkout -b recovery",
      "git fetch origin feature",
      "/usr/bin/git push origin main",
    ]) {
      const blocked = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({ arguments: { command } }),
        encoding: "utf8",
      });
      expect(blocked.stdout, command).toContain('"allow":false');
    }

    for (const command of ["git status --short", "git diff --check", "git log -1 --oneline", "git rev-parse HEAD"]) {
      const allowed = spawnSync("bun", ["run", SCRIPT], {
        input: JSON.stringify({ arguments: { command } }),
        encoding: "utf8",
      });
      expect(allowed.stdout, command).toContain('"allow":true');
    }
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

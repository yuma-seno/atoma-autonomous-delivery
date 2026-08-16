import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { makeConfigDir, scriptPath } from "./testing/harness.ts";

function run(config: Record<string, unknown>) {
  const dir = makeConfigDir(config);
  try {
    return spawnSync("bun", ["run", scriptPath("run_checks.ts")], { encoding: "utf8", cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("run_checks.ts", () => {
  test("runs the configured commands in order", () => {
    const r = run({ checks: { commands: ["echo one", "echo two"] } });
    expect(r.status).toBe(0);
    expect(r.stdout.indexOf("one")).toBeLessThan(r.stdout.indexOf("two"));
  });

  test("stops at the first failure and exits with its code", () => {
    const r = run({ checks: { commands: ["echo before", "exit 3", "echo after"] } });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("before");
    expect(r.stdout).not.toContain("after");
    expect(r.stderr).toContain("::error::");
  });

  // A repository pointing workflows.ci at its own workflow has no reason to fill
  // this in, and failing its runs over an empty list would make adopting Atoma
  // harder than not adopting it.
  test("declaring nothing is not a failure", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to verify");
  });

  test("an all-whitespace command is not treated as a command", () => {
    const r = run({ checks: { commands: ["  ", ""] } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to verify");
  });
});

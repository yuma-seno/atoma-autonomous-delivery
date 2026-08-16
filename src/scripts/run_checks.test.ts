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

  // This workflow is the default `workflows.ci`, so an empty list means a pull
  // request satisfied a required check that tested nothing. Failing instead
  // would block every pull request from the moment a repository adopts Atoma
  // until someone configures it, which is a worse first hour.
  test("declaring nothing passes, but says so as a warning", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("verified nothing");
  });

  test("an all-whitespace command is not treated as a command", () => {
    const r = run({ checks: { commands: ["  ", ""] } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("verified nothing");
  });
});

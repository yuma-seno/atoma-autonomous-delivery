import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { makeConfigDir, scriptPath } from "./testing/harness.ts";

describe("run_environment_setup.ts", () => {
  test("runs configured setup commands in order", () => {
    const dir = makeConfigDir({ environment: { setup_commands: ["echo one", "echo two"] } });
    try {
      const r = spawnSync("bun", ["run", scriptPath("run_environment_setup.ts")], { encoding: "utf8", cwd: dir });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("one");
      expect(r.stdout).toContain("two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aborts with the failing command's exit code", () => {
    const dir = makeConfigDir({ environment: { setup_commands: ["exit 3"] } });
    try {
      const r = spawnSync("bun", ["run", scriptPath("run_environment_setup.ts")], { encoding: "utf8", cwd: dir });
      expect(r.status).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no-ops quietly when no setup_commands are configured", () => {
    const dir = makeConfigDir({});
    try {
      const r = spawnSync("bun", ["run", scriptPath("run_environment_setup.ts")], { encoding: "utf8", cwd: dir });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("skipping");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

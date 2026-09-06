import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGithubOutput, scriptPath } from "./testing/harness.ts";

describe("decide_guard_release.ts", () => {
  function run(args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "atoma-guard-release-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    try {
      const r = spawnSync("bun", ["run", scriptPath("decide_guard_release.ts"), ...args], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: outputFile },
      });
      return { status: r.status, out: parseGithubOutput(readFileSync(outputFile, "utf8")) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("releases on a failed run outcome", () => {
    const { status, out } = run(["--outcome", "failure"]);
    expect(status).toBe(0);
    expect(out.should_release).toBe("true");
  });

  test("stays held when a directive hands off to another agent", () => {
    const { out } = run(["--outcome", "success", "--directive", "reviewer"]);
    expect(out.should_release).toBe("false");
  });

  test("stays held when the chain already continues via a tool-triggered dispatch", () => {
    const { out } = run(["--outcome", "success", "--chain-continues", "true"]);
    expect(out.should_release).toBe("false");
  });

  test("releases when the run reached its limit even mid-chain", () => {
    const { out } = run(["--outcome", "success", "--limit-reached", "true", "--chain-continues", "true"]);
    expect(out.should_release).toBe("true");
  });

  test("releases when nothing further is happening", () => {
    const { out } = run(["--outcome", "success"]);
    expect(out.should_release).toBe("true");
  });

  test("fails open (releases) when --outcome is missing entirely, instead of leaving the guard stuck", () => {
    const { status, out } = run([]);
    expect(status).toBe(0);
    expect(out.should_release).toBe("true");
  });
});

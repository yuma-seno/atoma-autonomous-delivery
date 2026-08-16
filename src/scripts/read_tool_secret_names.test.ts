import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeConfigDir, parseGithubOutput, scriptPath } from "./testing/harness.ts";

/** Run the script against a throwaway config.json, capturing its step output. */
function run(config: Record<string, unknown>) {
  const dir = makeConfigDir(config);
  const outputPath = join(dir, "github_output");
  writeFileSync(outputPath, "");
  try {
    const r = spawnSync("bun", ["run", scriptPath("read_tool_secret_names.ts")], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    return { ...r, outputs: parseGithubOutput(readFileSync(outputPath, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("read_tool_secret_names.ts", () => {
  test("publishes the declared names as a JSON array", () => {
    const r = run({ tool_secrets: ["SLACK_TOKEN", "JIRA_API_TOKEN"] });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.outputs.names!)).toEqual(["SLACK_TOKEN", "JIRA_API_TOKEN"]);
  });

  // The workflow indexes into this unconditionally, so it has to be valid JSON
  // even when nothing is configured -- which is the common case.
  test("publishes an empty array when nothing is declared", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(JSON.parse(r.outputs.names!)).toEqual([]);
  });

  test("names the declared secrets in the log so a missing one is diagnosable", () => {
    const r = run({ tool_secrets: ["SLACK_TOKEN"] });
    expect(r.stderr).toContain("SLACK_TOKEN");
  });

  test("fails the run on an unusable declaration, as a workflow error", () => {
    const r = run({ tool_secrets: ["GH_TOKEN"] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::");
    expect(r.stderr).toContain("GH_TOKEN");
    expect(r.outputs.names).toBeUndefined();
  });

  test("reports every problem rather than only the first", () => {
    const r = run({ tool_secrets: ["bad name", "GH_TOKEN"] });
    expect(r.status).toBe(1);
    expect(r.stderr.match(/::error::/g)).toHaveLength(2);
  });
});

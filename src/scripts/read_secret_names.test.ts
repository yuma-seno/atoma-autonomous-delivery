import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeConfigDir, parseGithubOutput, scriptPath } from "./testing/harness.ts";

/** Run the script against a throwaway config.json, capturing its step output. */
function run(config: Record<string, unknown>, destination = "tools") {
  const dir = makeConfigDir(config);
  const outputPath = join(dir, "github_output");
  writeFileSync(outputPath, "");
  try {
    const r = spawnSync("bun", ["run", scriptPath("read_secret_names.ts"), "--destination", destination], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    return { ...r, outputs: parseGithubOutput(readFileSync(outputPath, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("read_secret_names.ts", () => {
  test("publishes the declared names as a JSON array", () => {
    const r = run({ tools: { secrets: ["SLACK_TOKEN", "JIRA_API_TOKEN"] } });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.outputs.names!)).toEqual(["SLACK_TOKEN", "JIRA_API_TOKEN"]);
  });

  // Each destination reads its own list. Crossing them would put a deployment
  // credential in the agent's environment, which is the boundary this exists for.
  test("reads only the destination it was asked for", () => {
    const config = {
      tools: { secrets: ["SLACK_TOKEN"] },
      checks: { secrets: ["NPM_TOKEN"] },
      deploy: { secrets: ["AWS_ROLE_ARN"] },
    };
    expect(JSON.parse(run(config, "tools").outputs.names!)).toEqual(["SLACK_TOKEN"]);
    expect(JSON.parse(run(config, "checks").outputs.names!)).toEqual(["NPM_TOKEN"]);
    expect(JSON.parse(run(config, "deploy").outputs.names!)).toEqual(["AWS_ROLE_ARN"]);
  });

  // The workflow indexes into this unconditionally, so it has to be valid JSON
  // even when nothing is configured -- which is the common case.
  test("publishes an empty array when nothing is declared", () => {
    for (const destination of ["tools", "checks", "deploy"]) {
      const r = run({}, destination);
      expect(r.status, destination).toBe(0);
      expect(JSON.parse(r.outputs.names!), destination).toEqual([]);
    }
  });

  test("names the declared secrets in the log so a missing one is diagnosable", () => {
    expect(run({ tools: { secrets: ["SLACK_TOKEN"] } }).stderr).toContain("SLACK_TOKEN");
  });

  test("fails the run on an unusable declaration, as a workflow error", () => {
    const r = run({ tools: { secrets: ["GH_TOKEN"] } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::");
    expect(r.stderr).toContain("GH_TOKEN");
    expect(r.outputs.names).toBeUndefined();
  });

  test("reports every problem rather than only the first", () => {
    const r = run({ tools: { secrets: ["bad name", "GH_TOKEN"] } });
    expect(r.status).toBe(1);
    expect(r.stderr.match(/::error::/g)).toHaveLength(2);
  });

  test("refuses a destination it does not know", () => {
    const r = run({}, "agent");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown destination");
  });
});

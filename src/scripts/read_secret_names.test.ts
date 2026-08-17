import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGithubOutput, scriptPath } from "./testing/harness.ts";
import { declarationIn } from "./read_secret_names.ts";

/**
 * Run the script against a config file it is handed.
 *
 * Deliberately not `makeConfigDir`: this script must not read
 * `.github/atoma/config.json` from the working directory, and a harness that
 * puts one there would hide a regression that reintroduced it.
 */
function run(config: Record<string, unknown> | null, destination = "tools") {
  const dir = mkdtempSync(join(tmpdir(), "atoma-declared-"));
  const configPath = join(dir, "trusted-config.json");
  const outputPath = join(dir, "github_output");
  if (config !== null) writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(outputPath, "");
  try {
    const r = spawnSync(
      "bun",
      ["run", scriptPath("read_secret_names.ts"), "--destination", destination, "--config", configPath],
      { encoding: "utf8", cwd: dir, env: { ...process.env, GITHUB_OUTPUT: outputPath } },
    );
    return { ...r, outputs: parseGithubOutput(readFileSync(outputPath, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("declarationIn", () => {
  test("picks the destination's own list", () => {
    const config = JSON.stringify({
      tools: { secrets: ["A"] },
      checks: { secrets: ["B"] },
      deploy: { secrets: ["C"] },
    });
    expect(declarationIn(config, "tools")).toEqual(["A"]);
    expect(declarationIn(config, "checks")).toEqual(["B"]);
    expect(declarationIn(config, "deploy")).toEqual(["C"]);
  });

  test("an absent section declares nothing", () => {
    expect(declarationIn("{}", "tools")).toBeUndefined();
  });
});

describe("read_secret_names.ts", () => {
  test("publishes the declared names as a JSON array", () => {
    const r = run({ tools: { secrets: ["SLACK_TOKEN", "JIRA_API_TOKEN"] } });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.outputs.names!)).toEqual(["SLACK_TOKEN", "JIRA_API_TOKEN"]);
  });

  // Crossing these would put a deployment credential in the agent's own
  // environment, which is the boundary the three lists exist to draw.
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

  // The state of a repository that has configured none. Failing every run over
  // it would be worse than the empty answer, which is also the safe one.
  test("a config file that is not there declares nothing, and does not fail", () => {
    const r = run(null);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.outputs.names!)).toEqual([]);
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

  // Requiring the argument made a deployment break itself: a deploy pull request
  // is reviewed by a run whose workflow YAML comes from the base branch and whose
  // scripts come from the pull request, so the first release to pass `--config`
  // met the previous release's workflow, which did not.
  //
  // Failing closed instead is safe in the direction that matters -- no argument,
  // no credentials -- and never reaches for the working tree, which is the thing
  // a pull request controls.
  test("declares nothing, loudly, when not told which config to trust", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-declared-"));
    const outputPath = join(dir, "github_output");
    writeFileSync(outputPath, "");
    // A config.json in the working directory, to catch a fallback that reaches
    // for it: this must be ignored, not used.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ tools: { secrets: ["SHOULD_NOT_APPEAR"] } }));
    try {
      const r = spawnSync("bun", ["run", scriptPath("read_secret_names.ts"), "--destination", "tools"], {
        encoding: "utf8",
        cwd: dir,
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("::warning::");
      expect(r.stderr).not.toContain("SHOULD_NOT_APPEAR");
      expect(JSON.parse(parseGithubOutput(readFileSync(outputPath, "utf8")).names!)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

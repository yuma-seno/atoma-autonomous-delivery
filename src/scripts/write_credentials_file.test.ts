import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect } from "./write_credentials_file.ts";
import { scriptPath } from "./testing/harness.ts";

describe("collect", () => {
  test("takes the credentials the run always needs", () => {
    expect(
      collect({
        OPENAI_API_KEY: "sk-x",
        GH_TOKEN: "ghs-y",
        ATOMA_SECRET_NAMES: "[]",
      }),
    ).toEqual({ OPENAI_API_KEY: "sk-x", GH_TOKEN: "ghs-y" });
  });

  // The whole point: this is not a dump of the environment.
  test("takes nothing it was not asked for", () => {
    const out = collect({
      OPENAI_API_KEY: "sk-x",
      SOME_OTHER_SECRET: "should-not-travel",
      PATH: "/usr/bin",
      ATOMA_SECRET_NAMES: "[]",
    });
    expect(Object.keys(out)).toEqual(["OPENAI_API_KEY"]);
  });

  test("puts a declared credential under its own name", () => {
    expect(
      collect({
        ATOMA_SECRET_NAMES: '["SLACK_TOKEN","JIRA_API_TOKEN"]',
        ATOMA_SECRET_0: "xoxb-1",
        ATOMA_SECRET_1: "jira-2",
      }),
    ).toEqual({ SLACK_TOKEN: "xoxb-1", JIRA_API_TOKEN: "jira-2" });
  });

  // An unset repository secret arrives as an empty string. Writing it would tell
  // atoma's provider detection that a provider is configured when it is not.
  test("omits an empty value rather than writing it", () => {
    const out = collect({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "sk-ant", ATOMA_SECRET_NAMES: "[]" });
    expect(out).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });
  });

  test("warns about a declared credential the repository does not have", () => {
    const out = collect({ ATOMA_SECRET_NAMES: '["MISSING_TOKEN"]' });
    expect(out).toEqual({});
  });

  test("survives a names value that is not JSON", () => {
    expect(collect({ OPENAI_API_KEY: "sk-x", ATOMA_SECRET_NAMES: "not json" })).toEqual({ OPENAI_API_KEY: "sk-x" });
  });

  test("includes the Copilot token, so that provider works through this path", () => {
    expect(collect({ ATOMA_COPILOT_TOKEN: "ghu-x", ATOMA_SECRET_NAMES: "[]" })).toHaveProperty("ATOMA_COPILOT_TOKEN");
  });
});

describe("write_credentials_file.ts", () => {
  test("writes a JSON object atoma can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-creds-"));
    const out = join(dir, "credentials.json");
    try {
      const r = spawnSync("bun", ["run", scriptPath("write_credentials_file.ts"), "--out", out], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENAI_API_KEY: "sk-test",
          GH_TOKEN: "ghs-test",
          ATOMA_SECRET_NAMES: '["SLACK_TOKEN"]',
          ATOMA_SECRET_0: "xoxb-test",
        },
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
        OPENAI_API_KEY: "sk-test",
        GH_TOKEN: "ghs-test",
        SLACK_TOKEN: "xoxb-test",
      });
      // Names are diagnosable; values must never be logged.
      expect(r.stderr).toContain("SLACK_TOKEN");
      expect(r.stderr).not.toContain("xoxb-test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to run without a destination", () => {
    const r = spawnSync("bun", ["run", scriptPath("write_credentials_file.ts")], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});

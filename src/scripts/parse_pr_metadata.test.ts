import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_DIR, parseGithubOutput } from "./testing/harness.ts";

describe("parse_pr_metadata.ts", () => {
  test("parses parent-issue and Closes # references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/parse_pr_metadata.ts`], {
      encoding: "utf8",
      env: {
        ...process.env,
        PR_BODY: "<!-- atoma:parent-issue=42 -->\nCloses #7\nsome body",
        PR_NUMBER: "99",
        GITHUB_OUTPUT: outputFile,
      },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.parent_number).toBe("42");
    expect(out.sub_number).toBe("7");
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty outputs when no metadata present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/parse_pr_metadata.ts`], {
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "plain body", PR_NUMBER: "1", GITHUB_OUTPUT: outputFile },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.parent_number).toBe("");
    expect(out.sub_number).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

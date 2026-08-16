import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIPTS_DIR, parseGithubOutput } from "./testing/harness.ts";

describe("extract_notify_tag.ts", () => {
  test("extracts the notify tag from a PR body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    const r = spawnSync("bun", ["run", `${SCRIPTS_DIR}/extract_notify_tag.ts`], {
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "<!-- atoma:notify=octocat -->\nsome body", GITHUB_OUTPUT: outputFile },
    });
    expect(r.status).toBe(0);
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.notify).toBe("octocat");
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty when no tag present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const outputFile = join(dir, "out");
    writeFileSync(outputFile, "");
    spawnSync("bun", ["run", `${SCRIPTS_DIR}/extract_notify_tag.ts`], {
      encoding: "utf8",
      env: { ...process.env, PR_BODY: "no tag here", GITHUB_OUTPUT: outputFile },
    });
    const out = parseGithubOutput(await Bun.file(outputFile).text());
    expect(out.notify).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

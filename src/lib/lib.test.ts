/**
 * lib.test.ts — direct tests for src/lib/** functions that lost a
 * standalone CLI entry point during the "system" refactor (their logic was
 * absorbed into src/lib/ and is now called directly, via import, by every
 * caller instead of a subprocess spawn -- see aggregation.ts's doc comment).
 *
 * Since these are plain functions (no `main()`/CLI), each test spawns a
 * tiny generated shim script that imports and calls the target function,
 * reusing the SAME fake-`gh`-via-PATH test harness used for real CLI
 * scripts (src/scripts/testing/harness.ts) -- subprocess isolation is
 * required here, not just convenient: mutating process.env.PATH/
 * FAKE_GH_RESPONSES and calling a gh()-shelling function in the SAME
 * long-lived bun:test process has previously given wrong results (a
 * documented gotcha -- see git history), so every test that needs a faked
 * `gh` MUST spawn a fresh subprocess, never call such a function in-process.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfigDir, runWithFakeGh } from "../scripts/testing/harness.ts";

const LIB_DIR = import.meta.dir;

/** Writes a temp .ts file containing `code` and returns its absolute path. */
function makeShim(code: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "atoma-lib-shim-"));
  const file = join(dir, "shim.ts");
  writeFileSync(file, code);
  return { file, dir };
}

describe("sibling-check.ts countOpenSiblings", () => {
  test("counts open siblings via gh issue list", () => {
    const configDir = makeConfigDir({});
    const { file, dir } = makeShim(`
      import { countOpenSiblings } from "${join(LIB_DIR, "sibling-check.ts")}";
      console.log(countOpenSiblings({ repo: "owner/repo", parent: 5 }));
    `);
    try {
      const r = runWithFakeGh(file, [], {
        cwd: configDir,
        rules: [{ match: ["issue", "list"], stdout: JSON.stringify([{ number: 10 }, { number: 11 }]) }],
      });
      expect(r.stdout.trim()).toBe("2");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prints 0 when no siblings are open", () => {
    const configDir = makeConfigDir({});
    const { file, dir } = makeShim(`
      import { countOpenSiblings } from "${join(LIB_DIR, "sibling-check.ts")}";
      console.log(countOpenSiblings({ repo: "owner/repo", parent: 5 }));
    `);
    try {
      const r = runWithFakeGh(file, [], { cwd: configDir, rules: [{ match: ["issue", "list"], stdout: "[]" }] });
      expect(r.stdout.trim()).toBe("0");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--exclude drops a specific issue number regardless of its live open state", () => {
    const configDir = makeConfigDir({});
    const { file, dir } = makeShim(`
      import { countOpenSiblings } from "${join(LIB_DIR, "sibling-check.ts")}";
      console.log(countOpenSiblings({ repo: "owner/repo", parent: 5, exclude: 10 }));
    `);
    try {
      const r = runWithFakeGh(file, [], {
        cwd: configDir,
        rules: [{ match: ["issue", "list"], stdout: JSON.stringify([{ number: 10 }, { number: 11 }]) }],
      });
      expect(r.stdout.trim()).toBe("1");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("inject-sub-results.ts injectSubResultsFile", () => {
  test("replaces the last tool message with an aggregated summary", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    const sessionFile = join(dataDir, "session.json");
    const outFile = join(dataDir, "out.json");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        messages: [
          { role: "user", content: "go" },
          { role: "tool", content: "launched" },
        ],
      }),
    );
    const { file, dir } = makeShim(`
      import { injectSubResultsFile } from "${join(LIB_DIR, "inject-sub-results.ts")}";
      injectSubResultsFile(${JSON.stringify(sessionFile)}, "owner/repo", [2, 3], ${JSON.stringify(outFile)});
    `);
    try {
      const r = runWithFakeGh(file, [], {
        rules: [
          { match: ["issue", "view", "2"], stdout: JSON.stringify({ title: "Fix A", state: "CLOSED" }) },
          { match: ["issue", "view", "3"], stdout: JSON.stringify({ title: "Fix B", state: "CLOSED" }) },
          { match: ["pr", "list", "merged"], stdout: JSON.stringify([{ number: 10, title: "Fix A", url: "http://x/10" }]) },
          { match: ["pr", "list", "open"], stdout: "[]" },
        ],
      });
      expect(r.status).toBe(0);
      const session = JSON.parse(readFileSync(outFile, "utf8")) as { messages: { role: string; content: string }[] };
      const toolMsg = session.messages.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("Fix A");
      expect(toolMsg?.content).toContain("Fix B");
      expect(toolMsg?.content).toContain("PR #10");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tags.ts", () => {
  // Pure, no `gh` involved -- safe to test in-process directly.
  test("PARENT_TAG round-trips with the historical #-prefixed format", async () => {
    const { PARENT_TAG } = await import("./tags.ts");
    const written = PARENT_TAG.write(42);
    // Written with a literal "#" on purpose -- matches createIssue()'s
    // existing behavior and the GitHub search query string in
    // sibling-check.ts, both predating this module.
    expect(written).toBe("<!-- atoma:parent=#42 -->");
    expect(PARENT_TAG.read(`intro\n${written}\nmore text`)).toBe(42);
    // Also tolerates a hypothetical non-#-prefixed form on read.
    expect(PARENT_TAG.read("<!-- atoma:parent=42 -->")).toBe(42);
  });

  test("PARENT_ISSUE_TAG and readAnyParentTag", async () => {
    const { PARENT_ISSUE_TAG, readAnyParentTag } = await import("./tags.ts");
    expect(PARENT_ISSUE_TAG.write(7)).toBe("<!-- atoma:parent-issue=7 -->");
    expect(readAnyParentTag("<!-- atoma:parent-issue=7 -->")).toBe(7);
    expect(readAnyParentTag("<!-- atoma:parent=#8 -->")).toBe(8);
    expect(readAnyParentTag("no tags here")).toBeUndefined();
  });

  test("AGGREGATED_TAG idempotency marker", async () => {
    const { AGGREGATED_TAG } = await import("./tags.ts");
    const marker = AGGREGATED_TAG.write(9);
    expect(marker).toBe("<!-- atoma:aggregated=9 -->");
    expect(AGGREGATED_TAG.has(`some comment\n${marker}`)).toBe(true);
    expect(AGGREGATED_TAG.has("some other comment")).toBe(false);
  });

  test("LLM_CONTEXT_TAG marks human-visible notifications for exclusion", async () => {
    const { LLM_CONTEXT_TAG } = await import("./tags.ts");
    const marker = LLM_CONTEXT_TAG.write("exclude");
    expect(marker).toBe("<!-- atoma:llm-context=exclude -->");
    expect(LLM_CONTEXT_TAG.read(`${marker}\nAtoma: operation started.`)).toBe("exclude");
  });
});

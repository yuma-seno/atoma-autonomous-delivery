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

describe("agent-name.ts", () => {
  test("accepts a bare lowercase name and rejects everything a shell would reinterpret", async () => {
    const { isAgentName } = await import("./agent-name.ts");
    for (const valid of ["engineer", "orchestrator", "e", "code-reviewer", "agent2"]) {
      expect(isAgentName(valid), valid).toBe(true);
    }
    for (const invalid of [
      "",
      "Engineer",
      "2fast",
      "-leading",
      "with space",
      "engineer implement the thing",
      'engineer"; id; #',
      "engineer$(id)",
      "../../etc/passwd",
      "engineer\nreviewer",
    ]) {
      expect(isAgentName(invalid), invalid).toBe(false);
    }
  });

  // The pattern is embedded in a bash `[[ =~ ]]` test in the generated runner
  // workflow and in three tag regexes, so it has to stay a plain character
  // class: no anchors, no groups, no escapes that only mean something to one of
  // those three engines.
  test("is exported as a bare pattern body the bash and tag consumers can embed", async () => {
    const { AGENT_NAME_PATTERN } = await import("./agent-name.ts");
    expect(AGENT_NAME_PATTERN).toBe("[a-z][a-z0-9-]*");
  });
});

describe("tags.ts", () => {
  // Pure, no `gh` involved -- safe to test in-process directly.
  test("PARENT_TAG round-trips with the canonical numeric format", async () => {
    const { PARENT_TAG } = await import("./tags.ts");
    const written = PARENT_TAG.write(42);
    expect(written).toBe("<!-- atoma:parent=42 -->");
    expect(PARENT_TAG.read(`intro\n${written}\nmore text`)).toBe(42);
    expect(PARENT_TAG.read("<!-- atoma:parent=#42 -->")).toBeUndefined();
  });

  test("PARENT_ISSUE_TAG and readAnyParentTag", async () => {
    const { PARENT_ISSUE_TAG, readAnyParentTag } = await import("./tags.ts");
    expect(PARENT_ISSUE_TAG.write(7)).toBe("<!-- atoma:parent-issue=7 -->");
    expect(readAnyParentTag("<!-- atoma:parent-issue=7 -->")).toBe(7);
    expect(readAnyParentTag("<!-- atoma:parent=8 -->")).toBe(8);
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

describe("mcp-tool schema helpers", () => {
  test("positiveInt accepts a number and its string form, rejecting non-integers", async () => {
    const { positiveInt } = await import("./mcp-tool.ts");
    const schema = positiveInt("issue number");

    expect(schema.parse(185)).toBe(185);
    expect(schema.parse("185")).toBe(185);

    for (const bad of ["abc", "", 0, -1, 1.5, "1.5", null, {}]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });

  test("stringArray accepts an array and wraps a bare string", async () => {
    const { stringArray } = await import("./mcp-tool.ts");
    const schema = stringArray("label names");

    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(schema.parse("a")).toEqual(["a"]);

    for (const bad of [5, [1], null, {}]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });

  // A lenient runtime must not cost us a precise contract: zod-to-json-schema
  // silently emits `{}` for schemas built the wrong way (see mcp-tool.ts's
  // header), which would leave the model with no shape at all to follow.
  test("helpers still advertise a precise JSON Schema", async () => {
    const { positiveInt, stringArray } = await import("./mcp-tool.ts");
    const { zodToJsonSchema } = await import("zod-to-json-schema");

    const numberSchema = zodToJsonSchema(positiveInt("issue number"), {
      target: "jsonSchema7",
      $refStrategy: "none",
    }) as Record<string, unknown>;
    expect(numberSchema.type).toBe("integer");
    expect(numberSchema.description).toBe("issue number");

    const labelsSchema = zodToJsonSchema(stringArray("label names"), {
      target: "jsonSchema7",
      $refStrategy: "none",
    }) as Record<string, any>;
    expect(labelsSchema.type).toBe("array");
    expect(labelsSchema.items.type).toBe("string");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDirective } from "./extract_directive.ts";

describe("extract_directive.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "atoma-defdir-"));
  writeFileSync(join(dir, "reviewer.md"), "---\nname: reviewer\n---\n");
  writeFileSync(join(dir, "engineer.md"), "---\nname: engineer\n---\n");

  test("extracts a plain slash-command directive", () => {
    expect(extractDirective("Done.\n/reviewer", dir)).toBe("reviewer");
  });

  test("rejects instructions on the directive line", () => {
    expect(extractDirective("Done.\n/reviewer please check this.", dir)).toBe("");
  });

  test("extracts a markdown-mangled backtick-wrapped directive", () => {
    expect(extractDirective("All set.\n/`engineer`", dir)).toBe("engineer");
  });

  test("ignores a directive that names a non-existent agent", () => {
    expect(extractDirective("/agent reviewer", dir)).toBe("");
  });

  test("returns empty when there is no directive at all", () => {
    expect(extractDirective("Just a plain summary.", dir)).toBe("");
  });
});

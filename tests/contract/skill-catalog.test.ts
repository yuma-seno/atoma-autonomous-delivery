import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("skill catalog", () => {
  test("has valid, unique metadata and non-empty instructions", () => {
    const files: string[] = [];
    const collect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
      }
    };
    collect("src/atoma/skills");

    const names = new Set<string>();
    for (const file of files) {
      const document = readFileSync(file, "utf8");
      const match = document.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/);
      expect(match, `${file} must have YAML frontmatter and a body`).not.toBeNull();
      const metadata = Bun.YAML.parse(match![1]!) as { name?: string; description?: string };
      expect(metadata.name?.trim(), `${file} name`).toBeTruthy();
      expect(metadata.description?.trim(), `${file} description`).toBeTruthy();
      expect(match![2]!.trim(), `${file} instructions`).toBeTruthy();
      expect(names.has(metadata.name!), `duplicate skill name: ${metadata.name}`).toBe(false);
      names.add(metadata.name!);
    }

    // Not an exact count. What this guards is that the walk found anything at
    // all — a mistyped directory would make every check above vacuous and the
    // test would pass on zero files. Pinning the number instead made adding a
    // skill a test edit, which taught nothing and caught nothing.
    expect(files.length, "no skills found; check the walk's starting directory").toBeGreaterThan(0);
  });
});

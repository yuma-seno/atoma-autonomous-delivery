import { describe, expect, test } from "bun:test";
import { corpusFrom, shouldIndex } from "./code-corpus.ts";

describe("what the code search reads", () => {
  test("source, in whatever language the project is written in", () => {
    for (const path of [
      "src/domain/bm25.ts",
      "src/main.rs",
      "app/models/user.rb",
      "cmd/serve/main.go",
      "lib/parser.py",
      "docs/customization.md",
      "src/atoma/tools/tools.yaml",
    ]) {
      expect(shouldIndex(path), path).toBe(true);
    }
  });

  /**
   * `.github/atoma/**` is generated from `src/` by `build-dist.ts`. Indexing it serves
   * neither kind of repository: here it is a second copy of the source, so a search
   * returns the copy; in an adopter's, it is Atoma's implementation, so a question
   * about their project is answered with ours.
   */
  test("the deployed machinery is not the project's source", () => {
    for (const path of [
      ".github/atoma/tools/scripts/mcp/search.ts",
      ".github/scripts/post_result_comment.ts",
      ".github/workflows/atoma-runner.yml",
    ]) {
      expect(shouldIndex(path), path).toBe(false);
    }
  });

  /**
   * 300KB of resolved versions, every line of which matches a query about a package
   * name and none of which answers anything.
   */
  test("lock files are not writing", () => {
    for (const path of ["bun.lock", "package-lock.json", "Cargo.lock", "sub/dir/yarn.lock"]) {
      expect(shouldIndex(path), path).toBe(false);
    }
  });

  test("generated output is skipped wherever a project puts it", () => {
    for (const path of ["dist/index.js", "src/generated/out/api.ts", "target/debug/build.rs"]) {
      expect(shouldIndex(path), path).toBe(false);
    }
  });

  /**
   * Not an oversight. "Where is this tested" is a question worth answering, and
   * leaving tests out would be a guess about what somebody else wants to find.
   */
  test("tests are indexed on purpose", () => {
    expect(shouldIndex("src/domain/bm25.test.ts")).toBe(true);
    expect(shouldIndex("tests/contract/generated-workflows.test.ts")).toBe(true);
  });

  test("binaries and images are not text", () => {
    for (const path of ["docs/diagram.png", "assets/font.woff2", "bin/atoma"]) {
      expect(shouldIndex(path), path).toBe(false);
    }
  });
});

describe("the corpus", () => {
  test("is what git tracks, minus what is generated", () => {
    expect(
      corpusFrom([
        "src/b.ts",
        "src/a.ts",
        ".github/atoma/config.json",
        "bun.lock",
        "docs/readme.md",
        "",
        "  src/c.ts  ",
      ]),
    ).toEqual(["docs/readme.md", "src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  /**
   * Sorted, so an index built twice from the same tree is the same index. A ranking
   * that depended on the order a directory was walked in would be a ranking that
   * changed between runs for no reason anybody could see.
   */
  test("is ordered, so the same tree gives the same index", () => {
    const one = corpusFrom(["src/z.ts", "src/a.ts", "src/m.ts"]);
    const other = corpusFrom(["src/m.ts", "src/z.ts", "src/a.ts"]);
    expect(one).toEqual(other);
  });

  test("windows separators are normalised", () => {
    expect(corpusFrom(["src\\domain\\bm25.ts"])).toEqual(["src/domain/bm25.ts"]);
  });
});

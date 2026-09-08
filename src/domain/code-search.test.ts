import { describe, expect, test } from "bun:test";
import { buildIndex, score } from "./bm25.ts";
import {
  documentFor,
  passagesOf,
  rankFiles,
  resultsOf,
  type CodePassage,
} from "./code-search.ts";

const FILE = `/**
 * A module about one thing.
 */
export const LIMIT = 4;

/**
 * A second thing, further down, so it lands in its own passage.
 */
export function retryWithBackoff(attempt: number): number {
  return LIMIT * attempt;
}
`;

describe("passagesOf", () => {
  /**
   * The whole reason `splitBody` had to carry offsets: a result that names a file
   * makes the agent read the file, and a result that names lines makes it read the
   * lines.
   */
  test("every passage knows the lines it occupies", () => {
    const lines = FILE.split("\n");
    for (const passage of passagesOf("src/thing.ts", FILE)) {
      if (passage.startLine === 1 && passage.endLine === 1) continue; // the path passage
      const first = passage.text.split("\n")[0]!;
      expect(lines[passage.startLine - 1], `passage at ${passage.startLine}`).toContain(
        first.trim().slice(0, 20),
      );
    }
  });

  test("the line range is inclusive, so sed can use it directly", () => {
    const passages = passagesOf("a.ts", "one\ntwo\nthree\n\n\nfour five six seven eight nine ten\n");
    const last = passages.find((p) => p.text.startsWith("four"));
    expect(last?.startLine).toBe(6);
    expect(last?.endLine).toBe(6);
  });

  /**
   * File names in this repository are written to be read. A question about the
   * in-progress label should find `manage_in_progress_label.ts` by its name even when
   * no passage inside it says so.
   */
  test("the path is indexed as words", () => {
    const passages = passagesOf("src/scripts/manage_in_progress_label.ts", "x");
    const pathPassage = passages.at(-1)!;
    expect(pathPassage.text).toContain("manage in progress label");
    expect(pathPassage.text).toContain("src/scripts/manage_in_progress_label.ts");
  });

  test("an empty file contributes only its name", () => {
    expect(passagesOf("empty.ts", "")).toHaveLength(1);
  });
});

describe("rankFiles", () => {
  const passages: CodePassage[] = [
    { path: "a.ts", text: "one", startLine: 1, endLine: 1 },
    { path: "a.ts", text: "two", startLine: 5, endLine: 5 },
    { path: "b.ts", text: "three", startLine: 1, endLine: 1 },
  ];

  /**
   * Three passages of one 2,000-line file is a worse answer than three files, and a
   * file whose every passage scores a little is usually about something else.
   */
  test("one result per file, its best passage", () => {
    const ranked = rankFiles(passages, Float64Array.from([0.2, 0.9, 0.5]), 10);
    expect(ranked.map((m) => passages[m.passage]!.path)).toEqual(["a.ts", "b.ts"]);
    expect(passages[ranked[0]!.passage]!.text).toBe("two");
  });

  test("files that matched nothing are not results", () => {
    expect(rankFiles(passages, Float64Array.from([0, 0, 0]), 10)).toEqual([]);
  });

  test("the limit is honoured", () => {
    expect(rankFiles(passages, Float64Array.from([0.1, 0.2, 0.3]), 1)).toHaveLength(1);
  });
});

describe("documentFor", () => {
  /**
   * Not decoration: `src/domain/session-size.ts` tells a multilingual cross encoder
   * most of what the file is about before it reads a line.
   */
  test("the path travels with the passage", () => {
    expect(documentFor({ path: "src/domain/session-size.ts", text: "body", startLine: 1, endLine: 1 })).toBe(
      "src/domain/session-size.ts\nbody",
    );
  });

  test("a long passage is bounded", () => {
    const long = documentFor({ path: "a.ts", text: "x".repeat(5000), startLine: 1, endLine: 1 });
    expect(long.length).toBeLessThanOrEqual(1000);
  });
});

describe("resultsOf", () => {
  test("says the lines, ready for sed", () => {
    const passages: CodePassage[] = [{ path: "src/a.ts", text: "the answer", startLine: 120, endLine: 160 }];
    expect(resultsOf(passages, [{ passage: 0, score: 1 }], 700)).toEqual([
      { path: "src/a.ts", lines: "120-160", excerpt: "the answer" },
    ]);
  });

  test("the excerpt is bounded", () => {
    const passages: CodePassage[] = [{ path: "a.ts", text: "y".repeat(2000), startLine: 1, endLine: 9 }];
    expect(resultsOf(passages, [{ passage: 0, score: 1 }], 50)[0]!.excerpt).toHaveLength(50);
  });
});

/**
 * The measured claim, in miniature: a question phrased as a sentence finds the passage
 * that answers it, through the real BM25 and nothing else.
 */
describe("the two stages, end to end without the reranker", () => {
  test("a question reaches the right file", () => {
    const files = [
      ["src/domain/session-size.ts", "Above this many estimated tokens a restored session is shrunk before use."],
      ["src/domain/bm25.ts", "Character bigrams are the standard substitute for a morphological analyser."],
      ["src/scripts/run_checks.ts", "Runs the commands a project configured under checks, one after another."],
    ] as const;
    const passages = files.flatMap(([path, text]) => passagesOf(path, text));
    const index = buildIndex(passages.map((p) => p.text));

    const ranked = rankFiles(passages, score(index, "where are the checks a project configured actually run?"), 3);
    expect(passages[ranked[0]!.passage]!.path).toBe("src/scripts/run_checks.ts");
  });
});

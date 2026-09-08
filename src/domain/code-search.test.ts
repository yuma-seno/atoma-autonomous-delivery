import { describe, expect, test } from "bun:test";
import { buildIndex, score } from "./bm25.ts";
import {
  MIN_QUERY_COVERAGE,
  documentFor,
  passagesOf,
  queryCoverage,
  rankFiles,
  resultsOf,
  unknownNames,
  unknownNamesNotice,
  unreachableQueryReason,
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

  /**
   * A blank line only splits a section that is already too long to be about one
   * thing — the rule `splitBody` has always had, and the one I got wrong first: a
   * short file is one passage however many blank lines are in it.
   */
  test("a file short enough to be about one thing is one passage", () => {
    const passages = passagesOf("a.ts", "one\ntwo\n\nthree four five six seven eight nine ten\n");
    expect(passages.filter((p) => p.text.startsWith("one"))).toHaveLength(1);
  });

  test("the line range is inclusive, so sed can use it directly", () => {
    // Long enough that the blank line becomes a seam, with each half short enough
    // that the fixed-width cut does not also fire.
    const first = "a".repeat(400);
    const second = "b".repeat(400);
    const passages = passagesOf("a.ts", `${first}\n\n${second}`);

    const one = passages.find((p) => p.text.startsWith("a"))!;
    expect(one.startLine).toBe(1);
    expect(one.endLine).toBe(1);

    const other = passages.find((p) => p.text.startsWith("b"))!;
    expect(other.startLine, "after two newlines, the third line").toBe(3);
    expect(other.endLine).toBe(3);
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


/**
 * A CRLF checkout used to split differently from the runner's LF one, and that quietly
 * made a measurement mean something other than what it said. The sections below are
 * over the passage limit on purpose: under it there is only one passage either way, and
 * the test would pass without proving anything.
 */
describe("line endings", () => {
  const LF_TEXT = ["a".repeat(400), "", "", "b".repeat(400)].join(String.fromCharCode(10));
  const CRLF_TEXT = LF_TEXT.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10));

  test("a CRLF file is split exactly as its LF twin is", () => {
    const lf = passagesOf("a.ts", LF_TEXT);
    expect(lf.length).toBeGreaterThan(2);
    expect(passagesOf("a.ts", CRLF_TEXT)).toEqual(lf);
  });

  test("no carriage return survives into a passage", () => {
    for (const passage of passagesOf("a.ts", CRLF_TEXT)) {
      expect(passage.text).not.toContain(String.fromCharCode(13));
    }
  });
});

/**
 * The guard against a question that cannot reach this corpus, which is not a
 * hypothetical: the first real use asked in Japanese and was handed the one file with a
 * Japanese fixture in it. Nothing here knows what a language is, and these tests are
 * written so that it stays that way.
 *
 * What it does NOT catch is a question built from names that do not exist -- an earlier
 * version of this comment claimed it did, and the verification run proved otherwise.
 * That case belongs to `unknownNames`, tested below.
 */
describe("queryCoverage", () => {
  const index = buildIndex([
    "Above this many estimated tokens a restored session is shrunk before use.",
    "Runs the commands a project configured under checks, one after another.",
  ]);

  test("a question in the corpus's own words is fully covered", () => {
    expect(queryCoverage(index, "a restored session is shrunk")).toBe(1);
  });

  test("a question sharing nothing with the corpus scores zero", () => {
    expect(queryCoverage(index, "zqxjv wpblm")).toBe(0);
  });

  test("partial overlap lands in between", () => {
    const coverage = queryCoverage(index, "session zqxjvwpblmkgh");
    expect(coverage).toBeGreaterThan(0);
    expect(coverage).toBeLessThan(1);
  });

  /**
   * Why the threshold is nowhere near 1. A two-sentence corpus has no bigram for
   * "how", so an ordinary English question costs a little coverage against it without
   * being unanswerable -- and this is the small-corpus worst case, against a measured
   * minimum of 98.1% over thirty questions on the whole repository.
   */
  test("ordinary function words cost coverage without earning a refusal", () => {
    const coverage = queryCoverage(index, "how is a restored session shrunk");
    expect(coverage).toBeLessThan(1);
    expect(unreachableQueryReason(coverage)).toBeUndefined();
  });

  /** Zero of zero words is not a failure to reach the corpus; it is not a question. */
  test("a query with no tokens at all counts as covered", () => {
    expect(queryCoverage(index, "   ")).toBe(1);
  });
});

describe("unreachableQueryReason", () => {
  test("full coverage passes silently", () => {
    expect(unreachableQueryReason(1)).toBeUndefined();
  });

  test("the threshold itself passes, so the boundary is not a refusal", () => {
    expect(unreachableQueryReason(MIN_QUERY_COVERAGE)).toBeUndefined();
  });

  /**
   * The refusal replaces the results, so it has to carry what to do instead -- the
   * measured lesson being that the agent asked in Japanese even though the tool
   * description told it not to. A refusal that only says no earns the same outcome.
   */
  test("a refusal states the share and what to do instead", () => {
    const reason = unreachableQueryReason(0.12)!;
    expect(reason).toContain("12%");
    expect(reason).toContain("language");
    expect(reason).toContain("read a file");
  });
});


/**
 * The case coverage cannot see, and the reason it cannot.
 *
 * Measured on the verification run: `how does the FrobnicatorWidget reconcile its
 * ZuffleBuffer` scored 96.3% coverage and came back with three unrelated files, because
 * an invented English-looking name is spelled out of bigrams the corpus already has.
 * The name has to be checked as a name.
 */
describe("unknownNames", () => {
  const index = buildIndex([
    "export function stackedPrBase(parent: string): string | undefined {",
    "The watch_for_stop script polls for a stop request every thirty seconds.",
  ]);

  test("a name the codebase does not have is reported", () => {
    expect(unknownNames(index, "how does the FrobnicatorWidget reconcile its ZuffleBuffer")).toEqual([
      "FrobnicatorWidget",
      "ZuffleBuffer",
    ]);
  });

  test("a name the codebase does have is not reported", () => {
    expect(unknownNames(index, "how does stackedPrBase pick the parent branch")).toEqual([]);
    expect(unknownNames(index, "where does watch_for_stop write the file")).toEqual([]);
  });

  /**
   * The property that keeps this off ordinary questions. `branch` and `stop` are words
   * that happen to appear in code; only a word spelled the way code spells a name is a
   * claim about what exists, and only that claim can be wrong.
   */
  test("ordinary words are not treated as claims about what exists", () => {
    expect(unknownNames(index, "how does a run decide the base branch for a stacked pull request")).toEqual([]);
  });

  /** `tokenize` lowercases, so case is not a difference the index can see. */
  test("a real name in the wrong case is not reported", () => {
    expect(unknownNames(index, "what does STACKEDPRBASE return")).toEqual([]);
  });

  test("a name asked about twice is reported once", () => {
    expect(unknownNames(index, "does FrobnicatorWidget call FrobnicatorWidget again")).toEqual(["FrobnicatorWidget"]);
  });
});

describe("unknownNamesNotice", () => {
  test("nothing missing, nothing said", () => {
    expect(unknownNamesNotice([])).toBeUndefined();
  });

  /**
   * A note, not a refusal: the results are still ranked on the rest of the question, and
   * a name can be absent because it lives in a file the index leaves out. So it has to
   * name the names and say that second thing, or it reads as a false accusation.
   */
  test("the notice names the names and says why one might be missing innocently", () => {
    const notice = unknownNamesNotice(["FrobnicatorWidget", "ZuffleBuffer"])!;
    expect(notice).toContain("FrobnicatorWidget");
    expect(notice).toContain("ZuffleBuffer");
    expect(notice).toContain("the rest of the question");
    expect(notice).toContain("the index leaves out");
  });

  test("one name reads as one name", () => {
    expect(unknownNamesNotice(["ZuffleBuffer"])).toContain("That name does not exist");
  });
});

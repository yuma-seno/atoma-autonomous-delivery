import { describe, expect, test } from "bun:test";
import { buildIndex, rankIssues, score, splitBody, tokenize, type Chunk } from "./bm25.ts";

describe("splitBody", () => {
  test("splits on markdown headings, where the author already drew the line", () => {
    const body = [
      "## Symptom",
      "The reviewer returns LGTM and calls no tool, so the pull request is never touched again.",
      "",
      "## Cause",
      "The outcome table had no row for the case, so the model invented an ending for it.",
    ].join("\n");
    const parts = splitBody(body);
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("Symptom");
    expect(parts[1]).toContain("Cause");
  });

  test("drops fragments too short to be about anything", () => {
    expect(splitBody("## A\n\n## B\n\nok")).toEqual([]);
  });

  // A whole issue as one unit scored worse in measurement: everything in it
  // averages together and no single subject stands out.
  test("breaks a long section on blank lines", () => {
    const paragraph = "あ".repeat(400);
    const parts = splitBody(`${paragraph}\n\n${paragraph}`);
    expect(parts.length).toBe(2);
  });

  // This used to assert `splitBody("x".repeat(2000))[0].length === 700` and stop
  // there, which pinned the defect: the other 1300 characters were dropped, and
  // the test recorded the first chunk's size as if that were the whole story.
  describe("a passage too long even after splitting", () => {
    test("is cut into chunks of the limit", () => {
      const parts = splitBody("x".repeat(2000));
      expect(parts[0]!.length).toBe(700);
      expect(parts.every((p) => p.length <= 700)).toBe(true);
    });

    // The property that matters. A section with no heading and no blank line
    // inside it is ordinary in a long issue, and everything past the first chunk
    // was absent from the index entirely -- so a search for a phrase near the end
    // of a long body could not match it at all.
    test("keeps every character, rather than dropping the tail", () => {
      const parts = splitBody("x".repeat(2000));
      expect(parts.join("").length).toBe(2000);
    });

    test("keeps the end of a real body reachable", () => {
      const filler = "あ".repeat(1500);
      const parts = splitBody(`${filler}ブランチはコミット時に作られる`);
      expect(parts.some((p) => p.includes("ブランチはコミット時に作られる"))).toBe(true);
    });
  });
});

describe("tokenize", () => {
  // Japanese has no spaces, so whitespace tokenisation would make one token of
  // a whole sentence and BM25 would only match sentences repeated verbatim.
  test("makes character bigrams, so a Japanese phrase matches inside a sentence", () => {
    const document = tokenize("ブランチはコミット時に作られる");
    for (const bigram of tokenize("コミット")) {
      expect(document, `expected the document to contain ${bigram}`).toContain(bigram);
    }
  });

  test("keeps an identifier whole, because its bigrams are noise", () => {
    expect(tokenize("call commit_and_push first")).toContain("commit_and_push");
  });

  test("ignores punctuation and case", () => {
    expect(tokenize("A-B")).toEqual(tokenize("a b"));
  });
});

describe("score", () => {
  const documents = [
    "ブランチは最初のコミット時に作られる。報告だけの実行はブランチを残さない。",
    "シークレットがログに漏れるのを防ぐため、出力をマスクする。",
    "本日の天気は晴れ、最高気温は25度の見込みです。",
  ];

  test("ranks the passage that is about the query first", () => {
    const scores = score(buildIndex(documents), "ブランチはいつ作られるのか");
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[0]).toBeGreaterThan(scores[2]!);
  });

  test("scores nothing for a query with no shared terms", () => {
    const scores = score(buildIndex(documents), "zzzz");
    expect([...scores].every((s) => s === 0)).toBe(true);
  });

  test("survives an empty corpus", () => {
    expect(score(buildIndex([]), "anything").length).toBe(0);
  });
});

describe("rankIssues", () => {
  const chunks: Chunk[] = [
    { issue: 10, source: "body", text: "a" },
    { issue: 10, source: 3, text: "b" },
    { issue: 20, source: "title", text: "c" },
    { issue: 30, source: 1, text: "d" },
  ];

  // An issue discussed at length would otherwise fill the candidate list with
  // its own passages and crowd out every other issue.
  test("returns each issue once, scored by its best passage", () => {
    const scores = new Float64Array([0.1, 0.9, 0.5, 0.2]);
    expect(rankIssues(chunks, scores, 10).map((m) => m.issue)).toEqual([10, 20, 30]);
  });

  // The winning passage is why the issue is in the list. Dropping it is how a
  // search that found the right issue still leaves the answer unread.
  test("names the passage that won, not merely the issue", () => {
    const scores = new Float64Array([0.1, 0.9, 0.5, 0.2]);
    const best = rankIssues(chunks, scores, 10)[0]!;
    expect(best.issue).toBe(10);
    expect(chunks[best.chunk]!.source).toBe(3);
  });

  test("drops issues nothing matched", () => {
    const scores = new Float64Array([0, 0, 0.5, 0]);
    expect(rankIssues(chunks, scores, 10).map((m) => m.issue)).toEqual([20]);
  });

  test("honours the limit", () => {
    const scores = new Float64Array([0.1, 0.9, 0.5, 0.2]);
    expect(rankIssues(chunks, scores, 2).map((m) => m.issue)).toEqual([10, 20]);
  });
});

import { describe, expect, test } from "bun:test";
import { DEFAULT_COMMENT_WINDOW, selectCommentRange } from "./comment-range.ts";

describe("selectCommentRange", () => {
  test("no range reads the end of the conversation", () => {
    const range = selectCommentRange(20);
    expect(range.to).toBe(20);
    expect(range.from).toBe(20 - DEFAULT_COMMENT_WINDOW + 1);
    expect(range.count).toBe(DEFAULT_COMMENT_WINDOW);
    expect(range.showing).toContain("of 20");
  });

  test("a short issue is returned whole, and said to be", () => {
    const range = selectCommentRange(3);
    expect(range.from).toBe(1);
    expect(range.to).toBe(3);
    expect(range.showing).toBe("all 3 comment(s)");
  });

  // The form `search__search_issues` produces: it reports one comment number.
  test("from alone reads exactly that comment", () => {
    const range = selectCommentRange(20, 7);
    expect(range).toMatchObject({ from: 7, to: 7, count: 1 });
  });

  test("from and to read the range inclusively", () => {
    expect(selectCommentRange(20, 4, 6)).toMatchObject({ from: 4, to: 6, count: 3 });
  });

  test("to alone reads a window ending there", () => {
    const range = selectCommentRange(20, undefined, 10);
    expect(range.to).toBe(10);
    expect(range.count).toBe(DEFAULT_COMMENT_WINDOW);
  });

  test("bounds are clamped to what exists", () => {
    expect(selectCommentRange(3, 1, 99)).toMatchObject({ from: 1, to: 3, count: 3 });
    expect(selectCommentRange(3, undefined, 99).showing).toBe("all 3 comment(s)");
  });

  // The defect this module was extracted for. `from: 10` on a four-comment issue
  // produced "comment(s) 10-4 of 4; pass from/to to read the rest": a backwards
  // range, nothing returned, and an invitation to read the rest of nothing. The
  // caller had usually got that number from a search result pointing at a comment
  // that has since been deleted.
  describe("a range that covers nothing says why", () => {
    test("from past the end", () => {
      const range = selectCommentRange(4, 10);
      expect(range.count).toBe(0);
      expect(range.showing).toBe("there is no comment 10; this issue has 4");
      expect(range.showing).not.toContain("read the rest");
    });

    test("from after to", () => {
      const range = selectCommentRange(20, 9, 3);
      expect(range.count).toBe(0);
      expect(range.showing).toContain("covers nothing");
    });

    test("an issue with no comments at all", () => {
      const range = selectCommentRange(0);
      expect(range.count).toBe(0);
      expect(range.showing).toBe("this issue has no comments");
    });

    test("no comment number is ever reported backwards", () => {
      for (const [total, from, to] of [[4, 10, undefined], [20, 9, 3], [0, undefined, undefined]] as const) {
        const range = selectCommentRange(total, from, to);
        expect(range.showing, `${total}/${from}/${to}`).not.toMatch(/(\d+)-(\d+)/);
      }
    });
  });
});

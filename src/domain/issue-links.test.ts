import { describe, expect, test } from "bun:test";
import { claimsToClose, dedupeByNumber } from "./issue-links.ts";

describe("claimsToClose", () => {
  // The case this exists for. PR #284 carried `Closes #281` and targeted
  // `atoma/issue-280`, so GitHub formed no closing link and `willCloseTarget`
  // reported false. Without reading the body, a sub-issue's pull request is
  // invisible -- and a sub-issue is exactly where "we decided X" sits above an
  // unmerged pull request.
  test("finds a closing keyword for the issue", () => {
    expect(claimsToClose("<!-- atoma:parent-issue=281 -->\nCloses #281\n\nAdds a section.", 281)).toBe(true);
  });

  test("accepts the keywords GitHub accepts, in any case", () => {
    for (const line of ["closes #7", "Closed #7", "Fix #7", "fixes #7", "FIXED #7", "resolve #7", "Resolves #7"]) {
      expect(claimsToClose(line, 7), line).toBe(true);
    }
  });

  test("accepts the colon form GitHub also accepts", () => {
    expect(claimsToClose("Closes: #7", 7)).toBe(true);
  });

  // #286 mentioned #281 while closing #280. Counting it would attach the
  // parent's delivery to the child and report work as landed that is not.
  test("rejects a pull request that merely mentions the issue", () => {
    expect(claimsToClose("Issue #281 の作業成果です。", 281)).toBe(false);
  });

  test("does not confuse one issue number for another", () => {
    expect(claimsToClose("Closes #2810", 281)).toBe(false);
    expect(claimsToClose("Closes #281", 28)).toBe(false);
  });

  test("ignores a keyword that is not attached to a number", () => {
    expect(claimsToClose("This closes the discussion. See #281.", 281)).toBe(false);
  });
});

describe("dedupeByNumber", () => {
  test("keeps the first mention, so an authoritative source wins", () => {
    const declared = [{ number: 9, merged: true }];
    const referenced = [{ number: 9, merged: false }, { number: 4, merged: false }];
    expect(dedupeByNumber(declared, referenced)).toEqual([
      { number: 4, merged: false },
      { number: 9, merged: true },
    ]);
  });

  test("survives having nothing to merge", () => {
    expect(dedupeByNumber<{ number: number }>([], [])).toEqual([]);
  });
});

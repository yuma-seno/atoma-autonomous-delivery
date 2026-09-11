import { describe, expect, test } from "bun:test";
import { runWithFakeGh, scriptPath, type FakeGhRule } from "./testing/harness.ts";

/**
 * Who a run tells when something goes wrong, in the case where nothing in the thread
 * says. This is the fallback path -- every live trigger decides a notify where the run
 * starts, and `lib/notify.ts` explains why -- so these tests are about recovery.
 */
describe("resolve_notify.ts", () => {
  function run(rules: FakeGhRule[]) {
    return runWithFakeGh(scriptPath("resolve_notify.ts"), ["--repo", "acme/widgets", "--number", "7"], { rules });
  }

  test("a human author is the answer", () => {
    const r = run([{ match: ["api"], stdout: JSON.stringify({ body: "", login: "asked-for-it", type: "User" }) }]);
    expect(r.stdout.trim()).toBe("asked-for-it");
  });

  test("a notify tag beats the author", () => {
    const r = run([
      { match: ["api"], stdout: JSON.stringify({ body: "<!-- atoma:notify=requester -->", login: "someone-else", type: "User" }) },
    ]);
    expect(r.stdout.trim()).toBe("requester");
  });

  /**
   * A bot-authored issue with no tag and no parent used to resolve to nobody, and the
   * run then ended with a comment that mentioned no one -- a failure sitting on an
   * issue until somebody happened to look. Telling nobody is not a safer default than
   * telling the wrong person; it is the same failure with no one able to notice it.
   */
  test("nothing to go on falls back to the repository owner", () => {
    const r = run([{ match: ["api"], stdout: JSON.stringify({ body: "", login: "some-bot", type: "Bot" }) }]);
    expect(r.stdout.trim()).toBe("acme");
  });

  /** The same, when the issue cannot be read at all rather than being empty. */
  test("an unreadable issue falls back to the owner rather than to silence", () => {
    const r = run([{ match: ["api"], code: 1 }]);
    expect(r.stdout.trim()).toBe("acme");
  });
});

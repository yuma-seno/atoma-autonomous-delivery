import { describe, expect, test } from "bun:test";
import { runWithFakeGh, scriptPath, type FakeGhRule } from "./testing/harness.ts";

/**
 * The script end to end, through a fake `gh`, asserting on the commands it issues.
 *
 * `--dry-run` is what makes this cheap: the decision is taken against real GitHub
 * responses and printed, and nothing touches git. What is being checked is the half a
 * unit test of `domain/atoma-data-pruning.ts` cannot see — whether this file asks GitHub
 * the right question at all.
 *
 * It exists because it did not. `ghPaginated` takes the argv of a `gh` call and the
 * first word has to be `api`; the first version omitted it and every run died with
 * `unknown command "repos/…"`. Typecheck cannot catch a wrong string in a variadic
 * `...string[]`, and the failure only appeared when an issue was closed in production.
 */
const ISSUES = JSON.stringify([
  { number: 1, state: "open", labels: [] },
  { number: 2, state: "closed", labels: [] },
  { number: 3, state: "closed", labels: [{ name: "atoma/in-progress" }] },
]);

function run(rules: FakeGhRule[]) {
  return runWithFakeGh(scriptPath("prune_atoma_data.ts"), ["--repo", "acme/widgets", "--dry-run"], {
    rules,
  });
}

describe("prune_atoma_data.ts", () => {
  test("asks the issues API the way gh expects to be asked", () => {
    const result = run([{ match: ["api", "issues"], stdout: ISSUES }]);
    const asked = result.ghCalls.filter((argv) => argv.includes("issues"));
    expect(asked.length, "it should read the issues at all").toBeGreaterThan(0);
    for (const argv of asked) {
      // The bug this test exists for: without `api`, gh reads the path as a subcommand.
      expect(argv[0]).toBe("api");
      expect(argv).toContain("--paginate");
    }
  });

  test("reads both open and closed, since one call returns neither", () => {
    const result = run([{ match: ["api", "issues"], stdout: ISSUES }]);
    const queried = result.ghCalls.map((argv) => argv.join(" ")).join("\n");
    expect(queried).toContain("state=open");
    expect(queried).toContain("state=closed");
  });

  /**
   * A dry run is a dry run. If this ever pushes, it does so against a branch whose
   * sessions are being written by live jobs.
   */
  test("--dry-run touches no branch", () => {
    const result = run([{ match: ["api", "issues"], stdout: ISSUES }]);
    const pushes = result.ghCalls.filter((argv) => argv.includes("push"));
    expect(pushes).toEqual([]);
  });
});

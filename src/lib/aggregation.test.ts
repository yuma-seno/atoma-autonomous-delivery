import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfigDir, runWithFakeGh, type FakeGhRule } from "../scripts/testing/harness.ts";

const LIB_DIR = import.meta.dir;

/**
 * Run the gate against a faked `gh` and report what it decided and what it did.
 *
 * The subprocess is not optional: mutating PATH and calling a `gh`-shelling
 * function in the long-lived bun:test process has given wrong results before.
 * See this file's sibling, `lib.test.ts`, for the same harness and the same rule.
 */
function runGate(rules: FakeGhRule[]): { kind: string; ghCalls: string[][]; stderr: string } {
  const configDir = makeConfigDir({});
  const dir = mkdtempSync(join(tmpdir(), "atoma-gate-"));
  const file = join(dir, "shim.ts");
  writeFileSync(
    file,
    `import { dispatchOrchestratorIfReady } from "${join(LIB_DIR, "aggregation.ts")}";
const result = await dispatchOrchestratorIfReady({ repo: "owner/repo", parent: 5, closedNum: 10 });
console.log(result.kind);
`,
  );
  try {
    const r = runWithFakeGh(file, [], { cwd: configDir, rules });
    return { kind: r.stdout.trim().split("\n").pop() ?? "", ghCalls: r.ghCalls, stderr: r.stderr };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Did the gate start the orchestrator? That is a `workflow run` dispatch. */
const dispatched = (calls: string[][]) => calls.some((c) => c.includes("workflow") && c.includes("run"));

/** Did it claim the completion by writing the idempotency marker? */
const wroteMarker = (calls: string[][]) =>
  calls.some((c) => c.includes("comment") && c.some((a) => a.includes("atoma:aggregated")));

const NO_SIBLINGS: FakeGhRule = { match: ["issue", "list"], stdout: "[]" };
const NO_MARKER: FakeGhRule = { match: ["issue", "view"], stdout: "some unrelated comment" };

describe("aggregation.ts dispatch gate", () => {
  test("dispatches once when the siblings are done and nobody claimed it", () => {
    const { kind, ghCalls } = runGate([NO_SIBLINGS, NO_MARKER]);
    expect(kind).toBe("dispatched");
    expect(wroteMarker(ghCalls)).toBe(true);
    expect(dispatched(ghCalls)).toBe(true);
  });

  test("siblings still open is `waiting`, and nothing is claimed", () => {
    const { kind, ghCalls } = runGate([
      { match: ["issue", "list"], stdout: JSON.stringify([{ number: 11 }]) },
    ]);
    expect(kind).toBe("waiting");
    expect(wroteMarker(ghCalls)).toBe(false);
    expect(dispatched(ghCalls)).toBe(false);
  });

  test("another caller's marker makes this one a no-op", () => {
    const { kind, ghCalls } = runGate([
      NO_SIBLINGS,
      { match: ["issue", "view"], stdout: "<!-- atoma:aggregated=10 -->" },
    ]);
    expect(kind).toBe("already-aggregated");
    expect(dispatched(ghCalls)).toBe(false);
  });

  // The defect this issue was filed for. The marker IS the idempotency claim, so
  // failing to write it and dispatching anyway means the other racer -- which by
  // construction is running right now -- finds no marker, decides it is first,
  // and dispatches the orchestrator a second time. A missed aggregation is
  // recoverable by that racer; a double dispatch is not.
  test("a failed marker write stops the dispatch rather than racing on", () => {
    const { kind, ghCalls, stderr } = runGate([
      NO_SIBLINGS,
      NO_MARKER,
      { match: ["issue", "comment"], code: 1, stdout: "API rate limit exceeded" },
    ]);
    expect(kind).toBe("undetermined");
    expect(dispatched(ghCalls)).toBe(false);
    expect(stderr).toContain("aggregation marker");
  });

  // The read half of the same argument, which was already guarded. Kept so the
  // two halves cannot drift apart again.
  test("an unreadable comment list stops the dispatch too", () => {
    const { kind, ghCalls } = runGate([
      NO_SIBLINGS,
      { match: ["issue", "view"], code: 1, stdout: "not found" },
    ]);
    expect(kind).toBe("undetermined");
    expect(wroteMarker(ghCalls)).toBe(false);
    expect(dispatched(ghCalls)).toBe(false);
  });

  // `countOpenSiblings` throws rather than returning, and that exception used to
  // escape the gate entirely -- one call site wrapped it in try/catch and the
  // other did not, which was not a policy.
  test("an unreadable sibling list is undetermined, not an escaping exception", () => {
    const { kind, ghCalls } = runGate([{ match: ["issue", "list"], code: 1, stdout: "gh: not found" }]);
    expect(kind).toBe("undetermined");
    expect(dispatched(ghCalls)).toBe(false);
  });
});

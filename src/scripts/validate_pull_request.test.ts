import { describe, expect, test } from "bun:test";
import { pickDispatchedRun } from "./validate_pull_request.ts";

type Run = Parameters<typeof pickDispatchedRun>[0][number];

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    head_sha: "abc123",
    created_at: "2026-08-15T10:00:00Z",
    event: "workflow_dispatch",
    ...overrides,
  };
}

// `gh workflow run` returns nothing identifying the run it started, so it has to
// be recognised afterwards. Everything here is about not adopting the wrong one.
describe("pickDispatchedRun", () => {
  test("finds the run dispatched for this commit", () => {
    const picked = pickDispatchedRun([run({ id: 7 })], "abc123", "2026-08-15T09:59:00Z");
    expect(picked?.id).toBe(7);
  });

  // The case that makes matching on SHA rather than branch worth it: a human
  // pushing to the same branch while an agent works produces a different commit,
  // and its run must not be read as this validation's result.
  test("ignores a run for a different commit on the same branch", () => {
    const picked = pickDispatchedRun([run({ head_sha: "def456" })], "abc123", "2026-08-15T09:59:00Z");
    expect(picked).toBeUndefined();
  });

  test("ignores runs that predate the dispatch", () => {
    const earlier = run({ created_at: "2026-08-15T09:00:00Z" });
    expect(pickDispatchedRun([earlier], "abc123", "2026-08-15T09:59:00Z")).toBeUndefined();
  });

  // A `pull_request` run sits on the same commit, held at `action_required`.
  // Adopting it would read the hold as this validation's verdict.
  test("ignores runs from other events", () => {
    const held = run({ event: "pull_request", status: "completed", conclusion: "action_required" });
    expect(pickDispatchedRun([held], "abc123", "2026-08-15T09:59:00Z")).toBeUndefined();
  });

  test("takes the newest when a commit was validated more than once", () => {
    const runs = [
      run({ id: 1, created_at: "2026-08-15T10:00:00Z" }),
      run({ id: 2, created_at: "2026-08-15T10:05:00Z" }),
    ];
    expect(pickDispatchedRun(runs, "abc123", "2026-08-15T09:59:00Z")?.id).toBe(2);
  });

  test("reports a run that is still going rather than hiding it", () => {
    const picked = pickDispatchedRun([run({ status: "in_progress", conclusion: null })], "abc123", "2026-08-15T09:59:00Z");
    expect(picked?.status).toBe("in_progress");
    expect(picked?.conclusion).toBeNull();
  });
});

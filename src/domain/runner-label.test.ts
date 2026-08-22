import { describe, expect, test } from "bun:test";
import { DEFAULT_RUNNER, resolveRunsOn, runsOnOutput } from "./runner-label.ts";

describe("which machine a project's commands run on", () => {
  test("unset takes the shipped default", () => {
    expect(resolveRunsOn(undefined)).toEqual({ labels: [DEFAULT_RUNNER], problems: [] });
    expect(resolveRunsOn(null).labels).toEqual([DEFAULT_RUNNER]);
  });

  test("a string is one label", () => {
    expect(resolveRunsOn("macos-latest")).toEqual({ labels: ["macos-latest"], problems: [] });
    expect(resolveRunsOn("  ubuntu-22.04  ").labels, "trimmed").toEqual(["ubuntu-22.04"]);
  });

  /**
   * The self-hosted case, and the reason the array form exists: a self-hosted
   * runner is addressed by the labels it carries, all of them, on one machine. This
   * is not a matrix -- one job, one runner, several requirements.
   */
  test("a list is one runner that must have every label", () => {
    expect(resolveRunsOn(["self-hosted", "linux", "gpu"]).labels).toEqual(["self-hosted", "linux", "gpu"]);
  });

  /**
   * The default rather than a failure, because a workflow that cannot start reports
   * nothing about why -- the YAML is invalid and GitHub says so in a place nobody
   * reads. The problem travels separately, for `validate_deliverable` to show at
   * pull request time.
   */
  test("nonsense falls back to the default and says what was wrong", () => {
    for (const raw of [42, true, {}, "", "   "]) {
      const resolved = resolveRunsOn(raw);
      expect(resolved.labels, JSON.stringify(raw)).toEqual([DEFAULT_RUNNER]);
      expect(resolved.problems.length, JSON.stringify(raw)).toBeGreaterThan(0);
    }
  });

  test("a list with unusable entries keeps the usable ones and reports", () => {
    const resolved = resolveRunsOn(["self-hosted", 7, "", "linux"]);
    expect(resolved.labels).toEqual(["self-hosted", "linux"]);
    expect(resolved.problems.join(" ")).toContain("not non-empty strings");
  });

  test("a list of nothing usable falls back", () => {
    const resolved = resolveRunsOn([null, 3, "  "]);
    expect(resolved.labels).toEqual([DEFAULT_RUNNER]);
    expect(resolved.problems.join(" ")).toContain(DEFAULT_RUNNER);
  });
});

describe("handing the value to the next job", () => {
  /**
   * Always JSON, so the consumer is always `fromJSON(...)`. A bare string would work
   * for one label and silently select nothing for three, and the two forms would end
   * up written in different places.
   */
  test("one label and several are written the same way", () => {
    expect(runsOnOutput(["ubuntu-latest"])).toBe('["ubuntu-latest"]');
    expect(runsOnOutput(["self-hosted", "linux"])).toBe('["self-hosted","linux"]');
  });

  test("what it produces parses back to what went in", () => {
    for (const labels of [["ubuntu-latest"], ["self-hosted", "linux", "gpu"]]) {
      expect(JSON.parse(runsOnOutput(labels))).toEqual(labels);
    }
  });
});

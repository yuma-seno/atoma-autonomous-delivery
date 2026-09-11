import { describe, expect, test } from "bun:test";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  overLimitNotice,
  type WorkspaceUsage,
} from "./workspace-size.ts";

const PATH = "/tmp/atoma-workspace";

function usage(over: Partial<WorkspaceUsage> = {}): WorkspaceUsage {
  return { bytes: 1_000, files: 5, largest: [{ path: `${PATH}/notes.md`, bytes: 600 }], ...over };
}

describe("overLimitNotice", () => {
  test("the measured workspace says nothing", () => {
    // Five files and 142 bytes, across every issue this repository has run.
    expect(overLimitNotice({ bytes: 142, files: 5, largest: [] }, PATH)).toBeUndefined();
  });

  test("exactly at each limit is still nothing", () => {
    expect(overLimitNotice(usage({ bytes: MAX_TOTAL_BYTES }), PATH)).toBeUndefined();
    expect(overLimitNotice(usage({ files: MAX_FILES }), PATH)).toBeUndefined();
    expect(
      overLimitNotice(usage({ largest: [{ path: "a", bytes: MAX_FILE_BYTES }] }), PATH),
    ).toBeUndefined();
  });

  /**
   * The three limits exist separately because they have different causes, so the notice
   * has to say which one was reached -- "delete the bundle" and "you have copied a
   * dependency tree in here" are different sentences.
   */
  test("each limit says which one it is", () => {
    expect(overLimitNotice(usage({ bytes: MAX_TOTAL_BYTES + 1 }), PATH)).toContain("over the 5.0 MB limit");
    expect(overLimitNotice(usage({ files: MAX_FILES + 1 }), PATH)).toContain(`over the limit of ${MAX_FILES}`);
    expect(
      overLimitNotice(usage({ largest: [{ path: "a", bytes: MAX_FILE_BYTES + 1 }] }), PATH),
    ).toContain("one file is over the 1.0 MB single-file limit");
  });

  test("several files over the single-file limit read as several", () => {
    const notice = overLimitNotice(
      usage({
        largest: [
          { path: "a", bytes: MAX_FILE_BYTES + 1 },
          { path: "b", bytes: MAX_FILE_BYTES + 1 },
        ],
      }),
      PATH,
    );
    expect(notice).toContain("2 files are over");
  });

  test("two limits reached at once are both named", () => {
    const notice = overLimitNotice(usage({ bytes: MAX_TOTAL_BYTES + 1, files: MAX_FILES + 1 }), PATH)!;
    expect(notice).toContain("over the 5.0 MB limit");
    expect(notice).toContain(`over the limit of ${MAX_FILES}`);
  });

  /**
   * The consequence, not the rule. "Nothing you put there will reach the next run" is a
   * fact about the agent's work; "the workspace exceeds its limit" is a fact about our
   * configuration, and measured elsewhere here, a notice that only said no was ignored.
   */
  test("it names the consequence, the largest files, and what to do", () => {
    const notice = overLimitNotice(
      {
        bytes: 9 * 1024 * 1024,
        files: 4,
        largest: [
          { path: `${PATH}/build/bundle.js`, bytes: 8 * 1024 * 1024 },
          { path: `${PATH}/npm-debug.log`, bytes: 180 * 1024 },
        ],
      },
      PATH,
    )!;
    expect(notice).toContain("will reach the next run");
    expect(notice).toContain("build/bundle.js");
    expect(notice).toContain("8.0 MB");
    expect(notice).toContain("180 KB");
    expect(notice).toContain("Delete what the next run does not need");
    // Same shape as the block a tool server appends when it reports a problem about
    // itself, which the prompt already tells agents how to read.
    expect(notice).toContain("not part of the answer above");
  });
});

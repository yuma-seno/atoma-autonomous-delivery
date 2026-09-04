import { describe, expect, test } from "bun:test";
import type { Session } from "../lib/session.ts";
import { toolCallTally } from "./tool-tally.ts";

/** A session whose assistant turns made the given calls, in order. */
function session(...names: string[]): Session {
  return {
    messages: names.map((name, i) => ({
      role: "assistant",
      tool_calls: [{ id: `c${i}`, type: "function", function: { name, arguments: "{}" } }],
    })),
  };
}

describe("what a run spent its iterations on", () => {
  /**
   * The shape this exists to make visible: one tool at nearly every call. The run
   * that prompted it made 215 calls, 199 of them shell.
   */
  test("the most-used tool comes first, so going round is recognisable", () => {
    const tally = toolCallTally(session(...Array(9).fill("shell__shell_execute"), "github__get_issue"));
    expect(tally).toContain("10 tool calls");
    expect(tally).toContain("`shell__shell_execute` 9");
    expect(tally?.indexOf("shell__shell_execute")).toBeLessThan(tally?.indexOf("github__get_issue") ?? 0);
  });

  test("several calls in one turn are all counted", () => {
    const two: Session = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "a", function: { name: "shell__shell_execute" } },
            { id: "b", function: { name: "shell__shell_execute" } },
          ],
        },
      ],
    };
    expect(toolCallTally(two)).toContain("2 tool calls");
  });

  /** A long tail would bury the head, which is the only part that answers anything. */
  test("past the first few, the rest become a count", () => {
    const tally = toolCallTally(session("a__a", "b__b", "c__c", "d__d", "e__e", "f__f", "f__f"));
    // d__d and e__e, one call each. `f__f` is named because it has two.
    expect(tally).toContain("and 2 other tools 2");
    expect(tally).not.toContain("`e__e`");
  });

  test("one leftover tool reads as one", () => {
    const tally = toolCallTally(session("a__a", "b__b", "c__c", "d__d", "e__e"));
    expect(tally).toContain("and 1 other tool 1");
  });

  /**
   * The notice goes out either way. A tally is an addition to it, never a
   * precondition — so nothing to say has to be sayable.
   */
  test("nothing to say when there were no calls", () => {
    expect(toolCallTally(undefined)).toBeUndefined();
    expect(toolCallTally({})).toBeUndefined();
    expect(toolCallTally({ messages: [{ role: "user", content: "hi" }] })).toBeUndefined();
  });

  test("a malformed call is skipped rather than counted as a tool named undefined", () => {
    const odd: Session = {
      messages: [{ role: "assistant", tool_calls: [{ id: "a" }, { id: "b", function: {} }] }],
    };
    expect(toolCallTally(odd)).toBeUndefined();
  });
});

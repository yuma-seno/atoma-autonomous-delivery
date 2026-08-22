import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RELOAD_LIMIT,
  reloadAccepted,
  reloadRefusal,
  reloadsSoFar,
  resolveReloadLimit,
} from "./environment-reload.ts";

describe("how many reloads have happened", () => {
  test("a fresh run has had none", () => {
    expect(reloadsSoFar(undefined)).toBe(0);
    expect(reloadsSoFar("")).toBe(0);
    expect(reloadsSoFar("0")).toBe(0);
  });

  /**
   * The tally arrives as a workflow input, so it is a string by the time the tool
   * reads it. Numbers are accepted too rather than asserted against -- the caller
   * is a `process.env` read and the shape is not worth a second failure mode.
   */
  test("a string from the workflow input counts", () => {
    expect(reloadsSoFar("2")).toBe(2);
    expect(reloadsSoFar(" 3 ")).toBe(3);
    expect(reloadsSoFar(2)).toBe(2);
  });

  /**
   * Erring low here would let a broken input buy extra reloads, so anything
   * unreadable counts as zero -- which is the value a first run has anyway. The
   * limit still applies; only the starting point is generous.
   */
  test("nonsense counts as none rather than throwing", () => {
    for (const raw of ["abc", "-1", "1.5.2", null, {}, NaN]) {
      expect(reloadsSoFar(raw), JSON.stringify(raw) ?? String(raw)).toBe(0);
    }
    expect(reloadsSoFar("2.9"), "floored").toBe(2);
  });
});

describe("resolving the configured limit", () => {
  test("a usable value is taken", () => {
    expect(resolveReloadLimit(5)).toBe(5);
    expect(resolveReloadLimit("5")).toBe(5);
  });

  test("nothing usable means the default", () => {
    for (const raw of [undefined, null, 0, -2, "", "  ", "abc", NaN, Infinity, {}]) {
      expect(resolveReloadLimit(raw), JSON.stringify(raw) ?? String(raw)).toBe(DEFAULT_RELOAD_LIMIT);
    }
  });
});

describe("whether this reload may go ahead", () => {
  test("under the limit, it may", () => {
    expect(reloadRefusal(0, 3)).toBeUndefined();
    expect(reloadRefusal(2, 3)).toBeUndefined();
  });

  test("at the limit and beyond, it may not", () => {
    expect(reloadRefusal(3, 3)).toBeDefined();
    expect(reloadRefusal(9, 3)).toBeDefined();
  });

  /**
   * The refusal is what the agent has left to work with, so it has to say what to
   * do instead. A bare "limit reached" ends the run with the reason inside it.
   */
  test("the refusal names the count, the limit, and what to do instead", () => {
    const message = reloadRefusal(3, 3)!;
    expect(message).toContain("3 times");
    expect(message).toContain("(3)");
    expect(message, "tells it to report").toMatch(/Report what you found/);
    expect(message, "and where a system package actually goes").toContain("environment.setup_commands");
  });

  test("the count reads as English at one", () => {
    expect(reloadRefusal(1, 1)).toContain("1 time,");
  });
});

describe("what the agent is told when it is accepted", () => {
  /**
   * The tally is invisible to the agent otherwise -- reloads leave no comments, so
   * there is nothing for it to read back. Knowing this is the third of three
   * changes what a reasonable next step is.
   */
  test("names where it stands", () => {
    expect(reloadAccepted(3, 3)).toContain("3 of 3");
  });

  /**
   * The one thing a reload cannot do. An agent that reloads hoping for a system
   * package gets the same environment back and has spent a run finding out, so the
   * acceptance message says it before that happens rather than after.
   */
  test("says a new system package will not appear", () => {
    const message = reloadAccepted(1, 3);
    expect(message).toContain("system package");
    expect(message).toContain("environment.setup_commands");
    expect(message, "and that the session is over").toMatch(/session ends/);
  });
});

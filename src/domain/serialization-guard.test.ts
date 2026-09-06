import { describe, expect, test } from "bun:test";
import { shouldReleaseGuard, type TurnOutcomeSignals } from "./serialization-guard.ts";

function signals(overrides: Partial<TurnOutcomeSignals> = {}): TurnOutcomeSignals {
  return {
    succeeded: true,
    limitReached: false,
    loopLimitReached: false,
    chainContinues: false,
    directive: "",
    ...overrides,
  };
}

describe("shouldReleaseGuard", () => {
  test("releases when the run failed outright", () => {
    expect(shouldReleaseGuard(signals({ succeeded: false }))).toBe(true);
  });

  test("releases when the run failed even if a directive was also set (failure always wins)", () => {
    expect(shouldReleaseGuard(signals({ succeeded: false, directive: "engineer" }))).toBe(true);
  });

  test("releases when the run reached its limit", () => {
    expect(shouldReleaseGuard(signals({ limitReached: true }))).toBe(true);
  });

  test("releases when the auto-dispatch loop limit was reached", () => {
    expect(shouldReleaseGuard(signals({ loopLimitReached: true }))).toBe(true);
  });

  test("releases when nothing further is happening (no chain continuation, no directive)", () => {
    expect(shouldReleaseGuard(signals())).toBe(true);
  });

  test("stays held when a tool call already triggered a follow-up dispatch (chain continues)", () => {
    expect(shouldReleaseGuard(signals({ chainContinues: true }))).toBe(false);
  });

  test("stays held when a text directive hands off to another agent", () => {
    expect(shouldReleaseGuard(signals({ directive: "reviewer" }))).toBe(false);
  });

  test("stays held when both chain_continues and a directive are set", () => {
    expect(shouldReleaseGuard(signals({ chainContinues: true, directive: "reviewer" }))).toBe(false);
  });

  test("limit_reached overrides an in-flight chain continuation", () => {
    expect(shouldReleaseGuard(signals({ limitReached: true, chainContinues: true }))).toBe(true);
  });

  test("loop_limit_reached overrides a pending directive", () => {
    expect(shouldReleaseGuard(signals({ loopLimitReached: true, directive: "reviewer" }))).toBe(true);
  });
});

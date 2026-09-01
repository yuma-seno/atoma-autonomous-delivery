import { describe, expect, test } from "bun:test";
import type { ChainComment } from "./dispatch-chain.ts";
import {
  DEFAULT_NO_PROGRESS_LIMIT,
  noProgressLimitReached,
  resolveNoProgressLimit,
  runsWithoutChange,
  stopReason,
} from "./progress.ts";

/** Stands in for the tag reader the script passes; here, a marker in the body. */
const noChange = (body: string) => body.includes("[no-change]");

const changed: ChainComment = { authorType: "Bot", body: "engineer: pushed a fix" };
const unchanged: ChainComment = { authorType: "Bot", body: "engineer: [no-change] nothing to do" };
const person: ChainComment = { authorType: "User", body: "please try again" };
const machinery: ChainComment = { authorType: "Bot", body: "PR #12 created" };

describe("counting runs that changed nothing", () => {
  test("none, when the last run changed something", () => {
    expect(runsWithoutChange([unchanged, unchanged, changed], noChange)).toBe(0);
  });

  test("consecutive ones are counted from the newest backwards", () => {
    expect(runsWithoutChange([changed, unchanged, unchanged], noChange)).toBe(2);
  });

  test("a person's comment ends the walk", () => {
    expect(runsWithoutChange([unchanged, person, unchanged], noChange)).toBe(1);
  });

  /**
   * The case that decides the direction of this whole module. A run that ends by
   * creating a pull request posts no result comment -- its tool posts one instead --
   * so its progress is invisible here. Stopping at anything unrecognised means the
   * runs either side of it are not read as consecutive.
   */
  test("a comment from the machinery ends it too, so progress it cannot see is not ignored", () => {
    expect(runsWithoutChange([unchanged, machinery, unchanged], noChange)).toBe(1);
  });

  test("an empty thread counts nothing", () => {
    expect(runsWithoutChange([], noChange)).toBe(0);
  });
});

describe("the limit", () => {
  test("two are allowed and the third is refused", () => {
    expect(noProgressLimitReached(1, 2)).toBe(false);
    expect(noProgressLimitReached(2, 2)).toBe(true);
    expect(noProgressLimitReached(3, 2)).toBe(true);
  });

  test("zero and nonsense mean the default, as everywhere else here", () => {
    for (const configured of [undefined, null, 0, -3, "", "many", {}]) {
      expect(resolveNoProgressLimit(configured), JSON.stringify(configured) ?? "undefined").toBe(
        DEFAULT_NO_PROGRESS_LIMIT,
      );
    }
  });

  test("a configured limit is used, floored", () => {
    expect(resolveNoProgressLimit(4)).toBe(4);
    expect(resolveNoProgressLimit("3")).toBe(3);
    expect(resolveNoProgressLimit(2.9)).toBe(2);
  });
});

describe("what a person is told about why it stopped", () => {
  const limits = { handoffLimit: 5, noProgressLimit: 2 };

  test("nothing, while both limits are unreached", () => {
    const decision = stopReason({ handoffs: 3, runsWithoutChange: 1, ...limits });
    expect(decision.stop).toBe(false);
    expect(decision.reason).toBeUndefined();
  });

  test("the handoff limit says how many handoffs", () => {
    const decision = stopReason({ handoffs: 5, runsWithoutChange: 0, ...limits });
    expect(decision.stop).toBe(true);
    expect(decision.reason).toContain("5 agent handoffs");
    expect(decision.reason).toContain("limit 5");
  });

  test("the progress limit says what to look at instead of how many there were", () => {
    const decision = stopReason({ handoffs: 1, runsWithoutChange: 2, ...limits });
    expect(decision.stop).toBe(true);
    expect(decision.reason).toContain("changed nothing");
    expect(decision.reason).toContain("no commit was pushed");
  });

  /**
   * The message and the decision have to agree. Before this, the escalation comment
   * was built from the handoff count whatever the reason -- so a second limit beside
   * it would have told a person their chain was too long when it was not.
   */
  test("when both are reached, the more specific one is what is said", () => {
    const decision = stopReason({ handoffs: 9, runsWithoutChange: 4, ...limits });
    expect(decision.reason).toContain("changed nothing");
    expect(decision.reason).not.toContain("handoffs since");
  });
});

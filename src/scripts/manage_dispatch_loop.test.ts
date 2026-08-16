import { describe, expect, test } from "bun:test";
import { manageDispatchLoop } from "./manage_dispatch_loop.ts";

describe("manage_dispatch_loop.ts", () => {
  test("resets the counter when new events are present", () => {
    const { autoDispatchCount, loopLimitReached } = manageDispatchLoop(
      { metadata: { github_context: { auto_dispatch_count: 4 } } },
      1,
      "engineer",
    );
    expect(autoDispatchCount).toBe(0);
    expect(loopLimitReached).toBe(false);
  });

  test("increments the counter on a no-new-event auto-dispatch", () => {
    const { session, autoDispatchCount } = manageDispatchLoop(
      { metadata: { github_context: { auto_dispatch_count: 2 } } },
      0,
      "engineer",
    );
    expect(autoDispatchCount).toBe(3);
    expect(session.metadata?.github_context?.auto_dispatch_count).toBe(3);
  });

  test("does not increment when there is no directive", () => {
    const { autoDispatchCount } = manageDispatchLoop({ metadata: { github_context: { auto_dispatch_count: 2 } } }, 0, "");
    expect(autoDispatchCount).toBe(2);
  });

  test("reports loop_limit_reached once the count hits 5", () => {
    const { loopLimitReached } = manageDispatchLoop({ metadata: { github_context: { auto_dispatch_count: 4 } } }, 0, "engineer");
    expect(loopLimitReached).toBe(true);
  });
});

import { expect, test } from "bun:test";
import { addsUp } from "./probe-red.ts";

// Deliberately wrong. This is the failure the validation path is being watched
// against; the fix is to expect 3.
test("addsUp adds its arguments", () => {
  expect(addsUp(1, 2)).toBe(4);
});

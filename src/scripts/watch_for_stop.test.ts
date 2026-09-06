import { describe, expect, test } from "bun:test";
import { stopRequested, type StopComment } from "./watch_for_stop.ts";
import { STOP_TAG } from "../lib/tags.ts";

const REQUEST = `${STOP_TAG.write("requested")}\n@someone Atoma: stop requested.`;

describe("watch_for_stop.ts", () => {
  const since = new Date("2026-09-06T12:00:00Z");

  test("finds a stop request posted after the run started", () => {
    const comments: StopComment[] = [{ body: REQUEST, created_at: "2026-09-06T12:00:30Z" }];
    expect(stopRequested(comments, since)).toBe(true);
  });

  // Without the cutoff an issue that was ever stopped could never be worked on
  // again: every later run would find the old request on its first poll.
  test("ignores a stop request from an earlier run", () => {
    const comments: StopComment[] = [{ body: REQUEST, created_at: "2026-09-01T09:00:00Z" }];
    expect(stopRequested(comments, since)).toBe(false);
  });

  test("ignores ordinary comments", () => {
    const comments: StopComment[] = [
      { body: "please stop", created_at: "2026-09-06T12:00:30Z" },
      { body: "/stop", created_at: "2026-09-06T12:00:31Z" },
    ];
    expect(stopRequested(comments, since)).toBe(false);
  });

  // A stop somebody asked for must not be dropped because a timestamp was
  // unreadable. Stopping one run early is recoverable with a comment; the other
  // direction is a run nobody can interrupt.
  test("acts on a request whose timestamp cannot be read", () => {
    expect(stopRequested([{ body: REQUEST, created_at: "not a date" }], since)).toBe(true);
    expect(stopRequested([{ body: REQUEST }], since)).toBe(true);
  });

  test("nothing at all is not a stop", () => {
    expect(stopRequested([], since)).toBe(false);
  });
});

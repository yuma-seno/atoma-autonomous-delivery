import { afterEach, describe, expect, test } from "bun:test";
import { attachReportChannel, heldReports, report, resetReportChannel } from "./mcp-report.ts";

afterEach(() => resetReportChannel());

describe("a server saying it answered worse than it should have", () => {
  test("a report goes straight out once there is a channel", () => {
    const sent: string[] = [];
    attachReportChannel((level, message) => sent.push(`${level}: ${message}`));
    report("warning", "the reranker is not running");
    expect(sent).toEqual(["warning: the reranker is not running"]);
  });

  /**
   * The case the whole mechanism exists for. #499's reranker load begins at
   * startup and fails long before any tool is called, which is also before the
   * server has connected -- so a report that could only be sent through a live
   * connection would be the one report that never arrives.
   */
  test("what is said before the connection is held and sent when it opens", () => {
    report("warning", "could not preload the reranker");
    report("error", "and then the retry failed too");
    expect(heldReports().length, "nothing is lost while there is nowhere to send it").toBe(2);

    const sent: string[] = [];
    attachReportChannel((level, message) => sent.push(`${level}: ${message}`));
    expect(sent).toEqual([
      "warning: could not preload the reranker",
      "error: and then the retry failed too",
    ]);
    expect(heldReports(), "and is not sent a second time").toEqual([]);
  });

  /**
   * A server failing in a loop before it connects would otherwise grow this
   * without bound. The twenty-first report says nothing the first twenty did not.
   */
  test("the hold has a bottom", () => {
    for (let n = 0; n < 25; n += 1) report("warning", `problem ${n}`);
    expect(heldReports().length).toBe(20);
    expect(heldReports()[0]?.message, "the first are kept, not the last").toBe("problem 0");
  });

  /**
   * This is the channel that exists to carry the news that something is broken, so
   * it has to survive being broken itself. A throwing sink must not take the tool
   * call down with it.
   */
  test("a channel that throws falls back instead of failing the call", () => {
    attachReportChannel(() => {
      throw new Error("transport closed");
    });
    expect(() => report("warning", "something is wrong")).not.toThrow();
  });

  test("an empty report is not a report", () => {
    report("warning", "   ");
    expect(heldReports()).toEqual([]);
  });

  test("the message is trimmed, so a trailing newline does not travel", () => {
    const sent: string[] = [];
    attachReportChannel((_level, message) => sent.push(message));
    report("warning", "  the index could not be saved\n");
    expect(sent).toEqual(["the index could not be saved"]);
  });
});

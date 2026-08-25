/**
 * mcp-report.ts — how a server says that it answered worse than it should have.
 *
 * Not logging. `log()` is for a person reading a run afterwards; this is for the
 * agent that is about to use the answer. atoma attaches what arrives here to that
 * server's next tool result, so it reaches the run that is affected, in the place
 * it is affected — see atoma#13, and `engineering/environment` for what the agent
 * then does about it.
 *
 * ## Why not just keep writing WARN to stderr
 *
 * That works today, and it is why #499's reranker line is caught at all: atoma
 * reads a spawned server's stderr and guesses severity from the words. Guessing is
 * the fallback's defining weakness, and it fails in both directions —
 *
 *   - a report that does not happen to contain `warn` or `error` is never seen
 *   - a line that mentions one of those words while reporting nothing becomes a
 *     warning in front of the agent
 *
 * — neither of which announces itself. `notifications/message` carries the level
 * as a field, so nothing is inferred. It also works over any transport, which
 * matters the moment a server moves to a `url` (#525): a server atoma did not
 * start has no stderr atoma can read, and this becomes the only channel it has.
 *
 * ## What belongs here
 *
 * **What changed about the answer, not that something happened.** A message the
 * agent cannot act on costs it a result it has to read past, and a channel that
 * carries those is a channel that gets ignored — which would take the ones that
 * matter with it.
 *
 * Two questions, either one being yes:
 *
 *   - is the answer worse than it should have been? (the reranker fell back, so
 *     the results are first-stage ordered)
 *   - will the same thing happen on the next call? (the index cannot be saved, so
 *     every search from here rebuilds it)
 *
 * And one that is no on its own: a failure the result already describes. The agent
 * is being told; telling it twice in two shapes is noise. `mergePr`'s
 * `parent_outcome: "close-failed"` and `dispatch_sub_agent`'s error list are both
 * in the result, and both stay `log()`.
 *
 * ## Ordering
 *
 * A report made before the server has connected is held and sent once it has. That
 * is not an edge case: #499's load begins at startup, and the failure this whole
 * mechanism exists for happens before any tool has been called. atoma buffers it
 * from there until the first result, so it still arrives where it is used.
 */

/** The levels a server reports at. Below `warning` is a log line, not a report. */
export type ReportLevel = "warning" | "error";

type Sink = (level: ReportLevel, message: string) => void;

interface HeldReport {
  level: ReportLevel;
  message: string;
}

/**
 * How many reports are held while there is nowhere to send them.
 *
 * A server that fails in a loop before it connects would otherwise grow this
 * without bound. Twenty is past the point where the twenty-first says anything the
 * first twenty did not.
 */
const MAX_HELD = 20;

let sink: Sink | undefined;
let held: HeldReport[] = [];

/**
 * Say that something about this server is not right.
 *
 * Never throws and never fails a call: a server that cannot report is still a
 * server that answered. When the channel is not there — before the connection, or
 * because sending failed — the line goes to stderr instead, which atoma reads for
 * any server it started.
 */
export function report(level: ReportLevel, message: string): void {
  const text = message.trim();
  if (!text) return;
  if (!sink) {
    if (held.length < MAX_HELD) held.push({ level, message: text });
    return;
  }
  deliver(sink, level, text);
}

function deliver(to: Sink, level: ReportLevel, message: string): void {
  try {
    to(level, message);
  } catch (error) {
    // The fallback, and the reason it is worth having: this is the channel that
    // exists to carry the news that something is broken, so it has to survive
    // being broken itself.
    process.stderr.write(`WARN ${message} (could not be reported: ${(error as Error).message})\n`);
  }
}

/**
 * Point reports at the connection, and send whatever was waiting for it.
 *
 * Called by `serveMcpServer` once the transport is up. Everything said before that
 * moment goes out in the order it was said.
 */
export function attachReportChannel(next: Sink): void {
  sink = next;
  const waiting = held;
  held = [];
  for (const { level, message } of waiting) deliver(next, level, message);
}

/** For tests: forget the channel and anything held. */
export function resetReportChannel(): void {
  sink = undefined;
  held = [];
}

/** For tests: what is waiting for a channel. */
export function heldReports(): readonly HeldReport[] {
  return held;
}

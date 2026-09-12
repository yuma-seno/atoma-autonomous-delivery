/**
 * metrics-windows.ts — the same questions asked of different stretches of time.
 *
 * A single all-time table answers "what has this repository ever done" and nothing about
 * whether last week was better than the week before. That second question is the one
 * dogfooding exists to ask, so the report shows the same tables over several windows.
 *
 * ## What a window can be cut by
 *
 * `atoma_runs` in each session, written by atoma from v0.1.28: when a run started, when
 * it ended, why it ended. Before that, sessions carried no time at all — a session
 * records what was said and nothing about the saying of it.
 *
 * So the windows fill in from the first run after that version and not before. There is
 * no retrofit: git's commit dates on `atoma-data` looked like a free answer and are not,
 * because restoring the sessions that a prune had removed rewrote 97 of them to the same
 * afternoon. A date that is wrong is worse here than a date that is missing, because a
 * window silently containing the wrong runs reads exactly like one containing the right
 * ones.
 */

/** One run, as the windows need it. Mirrors atoma's `RunRecord`. */
export interface RunRecord {
  started: string;
  ended: string;
  seconds: number;
  /** `completed`, `iterations`, `runtime`, `stopped` or `failed`. */
  ended_because: string;
  messages: number;
}

/** A stretch of time the report covers. */
export interface Window {
  label: string;
  /** Days back from now, or `undefined` for everything. */
  days?: number;
}

/**
 * The windows the report shows, widest last.
 *
 * Seven and thirty because those are the two questions anybody actually asks — "is this
 * week worse" and "is this month worse" — and a third number between them would be a
 * column nobody reads. All time stays because for a while it is the only one with
 * anything in it.
 */
export const WINDOWS: Window[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "All time" },
];

/** Whether a run falls inside a window, given the moment the report is being made. */
export function within(run: RunRecord, window: Window, now: Date): boolean {
  if (window.days === undefined) return true;
  const ended = Date.parse(run.ended);
  if (Number.isNaN(ended)) return false;
  return now.getTime() - ended <= window.days * 86_400_000;
}

/** How runs ended, most common first. The rows that are not `completed` are the point. */
export function endings(runs: readonly RunRecord[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.ended_because, (counts.get(run.ended_because) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * The share of runs that ended for a reason other than finishing.
 *
 * Named for what it measures rather than for `ended_because`, because the number people
 * want is "how often does something give up", and every value except `completed` is an
 * instance of that.
 */
export function gaveUpShare(runs: readonly RunRecord[]): number {
  if (runs.length === 0) return 0;
  return runs.filter((r) => r.ended_because !== "completed").length / runs.length;
}

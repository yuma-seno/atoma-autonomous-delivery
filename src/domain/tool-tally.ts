/**
 * tool-tally.ts — what a run spent its iterations on, in one line.
 *
 * For the notice a person receives when a run hits its iteration limit. Before
 * this it said only that the limit was reached, which does not distinguish the two
 * cases a person has to choose between: a run that was making progress and needs
 * more budget, and a run that was going round and needs the task re-scoped.
 *
 * A tally separates them at a glance. The run that prompted this made 215 tool
 * calls, 199 of them `shell__shell_execute` — and that shape is recognisable
 * without opening a session or a workflow log.
 *
 * Deliberately not a report. #544 asked for one, and the measurement refused it:
 * these agents write no prose until their final turn, so a run cut off before that
 * has nothing to say. The session survives for a retry either way, so nothing is
 * lost — what was missing was the one thing a person needed to decide, and this is
 * that and nothing more.
 */
import type { Session } from "../lib/session.ts";

/** How many tools to name before the rest become a count. */
const NAMED = 4;

/**
 * `215 tool calls: shell__shell_execute 199, filesystem__read_text_file 8, ...`
 *
 * `undefined` when there is nothing to say — no session, or a session with no calls
 * in it. The caller posts its notice either way; this is an addition to it.
 */
export function toolCallTally(session: Session | undefined): string | undefined {
  const names: string[] = [];
  for (const message of session?.messages ?? []) {
    for (const call of (message.tool_calls as { function?: { name?: string } }[] | undefined) ?? []) {
      const name = call.function?.name;
      if (typeof name === "string" && name !== "") names.push(name);
    }
  }
  if (names.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);

  // Most-used first, because that is the answer to "was it going round" -- and one
  // tool at 90% of the calls is the shape worth seeing without counting.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked.slice(0, NAMED).map(([name, n]) => `\`${name}\` ${n}`);
  const rest = ranked.slice(NAMED);
  if (rest.length > 0) {
    const restCalls = rest.reduce((sum, [, n]) => sum + n, 0);
    shown.push(`and ${rest.length} other tool${rest.length === 1 ? "" : "s"} ${restCalls}`);
  }

  return `Spent on: ${names.length} tool calls — ${shown.join(", ")}.`;
}

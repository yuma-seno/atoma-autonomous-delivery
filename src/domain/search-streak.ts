/**
 * search-streak.ts — refusing a search when nothing the last ones found has been opened.
 *
 * # The failure this exists for
 *
 * Measured over 341 stored sessions and 5,746 tool calls, the three most expensive
 * sessions in the repository share one shape and only one:
 *
 * ```text
 *   session               longest run   searches   opens   prompt tokens
 *   issue-492/engineer            85         188      26           9.6M
 *   issue-200/engineer            44         124      37          13.0M
 *   issue-399 (#544)              30         173      62          19.7M
 * ```
 *
 * `issue-492` in full, `S` a search and `r` an open:
 *
 * ```text
 *   ___.rrr.rr.rSSrrrSSrrrSSSSSSrSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSrrSrSrSS...
 *   SSSSSSSSSSSSSrSSSSSSSSSSSSSSrSSrSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS...
 * ```
 *
 * **Eighty-five searches in a row without opening a single file.**
 *
 * Across all sessions the distribution is `p50 0, p75 0, p90 1, p95 3, p99 8`. Those
 * three are not a tail, they are a different animal.
 *
 * # Why this is the signal and repetition is not
 *
 * Every other candidate was measured and thrown out. Those runs have no repeated
 * calls, no cycles, no identical answers; they get new information nearly every call.
 * Nothing about *repetition* separates them, because they were not repeating — they
 * were enumerating.
 *
 * What separates them is semantic: **a search returns where something is, not what it
 * is.** A run that has searched fifteen times without opening anything has not used a
 * single thing it found. That is not an expensive run, it is not a run at all.
 *
 * # Why it refuses the act and not the run
 *
 * A refusal costs one search and tells the agent the thing it needs to hear. Stopping
 * the run costs the run. And a refusal is deterministic, so an agent that ignores it
 * gets the same refusal again — which the core's own `MAX_IDENTICAL_TOOL_FAILURES`
 * already stops. No new stopping rule anywhere.
 *
 * # What it cannot see
 *
 * Reads that go through the `filesystem` server, because this is a hook on `shell`.
 * Measured, those runs opened 0, 11 and 17 files that way against 124-188 searches, so
 * the over-count is small — and the threshold has the p99 doubled underneath it.
 *
 * A miss in either direction only makes the guard fire later or slightly sooner; it
 * cannot break a run. That is why matching text is acceptable here and was not
 * acceptable for tracking which file a shell command wrote to, where a miss would have
 * refused a legitimate re-read.
 */

/**
 * Searches in a row, with nothing opened, before one is refused.
 *
 * Fifteen, against a measured `p99` of 8 and a healthy `p95` of 3. Double the p99, so
 * the only sessions in the whole store it would have touched are the three above.
 */
export const MAX_SEARCHES_WITHOUT_OPENING = 15;

/** What a shell command does, as far as this rule is concerned. */
export type ShellAct = "search" | "open" | "other";

/** Locates. Returns a path, a line number, a count — never the thing itself. */
const SEARCHES = /^(grep|egrep|fgrep|rg|ag|ack|ugrep|find)$/;

/** Opens. Returns the content. */
const OPENS = /^(cat|bat|head|tail|sed|less|more|nl|od|xxd)$/;

/**
 * What this command is doing.
 *
 * Read from the first command of the pipeline, so `grep x foo.ts | head` is a search
 * (the `head` is pagination) and `head -50 foo.ts` is an open. `sed` counts as an open
 * because `sed -n '10,40p' file` is how a range gets read; `sed -i` is a write and is
 * refused elsewhere in this guard.
 *
 * `find . -exec cat {} \;` reads as a search, which is the one classification here that
 * is arguably wrong. It makes the guard fire slightly sooner, and the threshold has
 * room for it.
 */
export function classifyShellAct(command: string): ShellAct {
  const first = command
    .trim()
    .split(/\s*(?:\|\||&&|[;|])\s*/)[0]
    ?.trim()
    .split(/\s+/)
    // `VAR=x grep ...` and `sudo grep ...`: step over what is not the command itself.
    .find((token) => token.length > 0 && !token.includes("=") && token !== "sudo" && token !== "time");
  if (first === undefined) return "other";

  const name = first.split("/").pop() ?? first;
  if (SEARCHES.test(name)) return "search";
  if (OPENS.test(name)) return "open";
  return "other";
}

/**
 * The streak after this act.
 *
 * Only opening clears it. Running the test suite between searches is work, but it is
 * not using what the searches found — and an agent that searches ten times, runs the
 * tests, then searches ten more has still not opened anything.
 */
export function nextStreak(streak: number, act: ShellAct): number {
  if (act === "search") return streak + 1;
  if (act === "open") return 0;
  return streak;
}

/**
 * Why this search is refused, or nothing.
 *
 * Says what a search is for, because the agent has to know why opening is the next act
 * rather than a better pattern. `engineer.md` already says two or three fruitless
 * searches will not be answered by a fourth; eighty-five happened anyway, so the
 * sentence has to arrive at the moment it applies.
 */
export function refusalReason(streak: number, limit = MAX_SEARCHES_WITHOUT_OPENING): string | undefined {
  if (streak < limit) return undefined;
  return (
    `${streak} searches in a row without opening any of the files they found. A search returns ` +
    "where something is, not what it is, so nothing found so far has been read. Do one of two " +
    "things before searching again: open the most promising result — with " +
    "filesystem__read_text_file, or `sed -n` for a range — or, if you are guessing at what the " +
    "thing is called, ask search__search_code the same question in a sentence. Measured, that " +
    "finds the right file in the top five 70% of the time, against 41.5% for the regex patterns " +
    "agents search with."
  );
}

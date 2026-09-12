/**
 * metrics-report.ts — the metrics as something a person reads.
 *
 * Markdown, because it is rendered where it is stored and needs nothing installed to
 * read. It lives on `atoma-data` rather than in the repository: the working tree is the
 * deliverable, and a file that changes on every run would arrive in every pull request
 * for somebody to read past. Its own commit history is the trend line — the same
 * property that makes a diff of last week against this week free.
 *
 * ## What each section is for
 *
 * Every section answers a question somebody actually has, and the ones that cost money
 * come first. The sections that name **nothing** — a server never called, a skill never
 * loaded — are the ones worth reading most often: a server's tools and a skill
 * description sit in the prompt of every run, so something never used is paid for every
 * time and returns nothing.
 */
import type { Distribution, Metrics, Tally } from "./metrics.ts";
import { WINDOWS, endings, gaveUpShare, within, type RunRecord } from "./metrics-windows.ts";

/**
 * How the runs went, over each window.
 *
 * First, because it is the only section that answers "is this getting better or worse".
 * Everything below it is all-time and says what the repository has ever done.
 *
 * A window with nothing in it says so rather than being left out: a missing heading
 * reads as "nothing went wrong last week", and an empty row reads as what it is.
 * Sessions written before atoma v0.1.28 carry no times at all, so for a while every
 * window but the last is empty, and saying that plainly is the honest state of it.
 */
function runSection(runs: readonly RunRecord[], now: Date): string[] {
  const out = ["## Runs", ""];
  if (runs.length === 0) {
    out.push(
      "No run has recorded itself yet. Atoma writes `atoma_runs` into a session from " +
        "v0.1.28; sessions older than that carry no times, and there is no way to backfill " +
        "one that would not be a guess.",
      "",
    );
    return out;
  }

  out.push("| window | runs | gave up | median seconds | longest |");
  out.push("| --- | ---: | ---: | ---: | ---: |");
  for (const window of WINDOWS) {
    const inside = runs.filter((run) => within(run, window, now));
    if (inside.length === 0) {
      out.push(`| ${window.label} | 0 | — | — | — |`);
      continue;
    }
    const seconds = inside.map((r) => r.seconds).sort((a, b) => a - b);
    const median = seconds[Math.floor(seconds.length / 2)] ?? 0;
    const share = Math.round(gaveUpShare(inside) * 1000) / 10;
    const longest = seconds[seconds.length - 1] ?? 0;
    out.push(
      `| ${window.label} | ${n(inside.length)} | ${share}% | ${n(median)} | ${n(longest)} |`,
    );
  }
  out.push("");
  out.push(
    "**Gave up** is every ending that is not `completed` — a ceiling reached, a person " +
      "asking, a provider hanging up, a loop cut short. Each one is a mechanism deciding " +
      "the run should not continue, which is worth watching whether or not it was right.",
  );
  out.push("");
  out.push("| ended because | runs |");
  out.push("| --- | ---: |");
  for (const row of endings(runs)) out.push(`| \`${row.name}\` | ${n(row.count)} |`);
  out.push("");
  return out;
}
/** Thousands separators, because these numbers are read rather than computed with. */
function n(value: number): string {
  return value.toLocaleString("en-US");
}

function distributionRow(label: string, d: Distribution): string {
  return `| ${label} | ${n(d.p50)} | ${n(d.p90)} | ${n(d.p99)} | ${n(d.max)} | ${n(d.total)} |`;
}

function tallyTable(rows: readonly Tally[], of: number, what: string, unit: string): string[] {
  if (rows.length === 0) return [`No ${what} recorded.`];
  const out = [`| ${what} | ${unit} | share |`, "| --- | ---: | ---: |"];
  for (const row of rows) {
    const share = of === 0 ? 0 : Math.round((row.count / of) * 1000) / 10;
    out.push(`| \`${row.name}\` | ${n(row.count)} | ${share}% |`);
  }
  return out;
}

/**
 * The report.
 *
 * `now` is passed in rather than read from the clock so the same input renders the same
 * output — which is what lets a test assert on it, and what keeps a rerun that changed
 * nothing from producing a commit. It is also what the windows are measured back from.
 */
export function renderReport(metrics: Metrics, now: Date): string {
  const out: string[] = [];

  out.push("# Agent metrics");
  out.push("");
  out.push(
    `Read from ${n(metrics.sessions)} stored sessions on this branch. Nothing here is recorded ` +
      "specially: every number is something the agents already wrote down while working.",
  );
  out.push("");
  out.push(`Generated ${now.toISOString().slice(0, 10)}.`);
  out.push("");
  out.push(...runSection(metrics.runs, now));

  if (metrics.tokens) {
    const t = metrics.tokens;
    out.push("## Tokens");
    out.push("");
    out.push(
      `${n(t.total)} tokens over ${n(t.runs)} runs that reported them. **${Math.round(t.promptShare * 1000) / 10}% of ` +
        "that is prompt** — what the agents were made to read, not what they wrote. Anything " +
        "spent on making runs cheaper belongs on that side.",
    );
    out.push("");
    out.push("No money here, deliberately: of the four providers only one reports a cost, and a " +
      "price table goes quietly stale and then prints confident wrong numbers. Multiply by a " +
      "rate you know.");
    out.push("");
    out.push("| | p50 | p90 | p99 | max | total |");
    out.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    out.push(distributionRow("tokens per run", t.perRun));
    out.push("");
  }

  out.push("## Sessions");
  out.push("");
  out.push("| | p50 | p90 | p99 | max | total |");
  out.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  out.push(distributionRow("messages per session", metrics.messages));
  out.push("");
  out.push(...tallyTable(metrics.byAgent, metrics.sessions, "agent", "sessions"));
  out.push("");

  out.push("## Tools");
  out.push("");
  if (metrics.byTool.length === 0) {
    out.push("No tool calls recorded.");
  } else {
    out.push("Failure is counted by the result reading as an error, which is a string match and " +
      "so an estimate. A high rate is worth looking at either way: it is either a tool that " +
      "breaks or a tool the prompt points at wrongly.");
    out.push("");
    out.push("| tool | calls | failed | rate |");
    out.push("| --- | ---: | ---: | ---: |");
    for (const row of metrics.byTool) {
      const rate = row.count === 0 ? 0 : Math.round((row.failed / row.count) * 1000) / 10;
      out.push(`| \`${row.name}\` | ${n(row.count)} | ${n(row.failed)} | ${rate}% |`);
    }
  }
  out.push("");
  out.push("### Servers never used");
  out.push("");
  out.push(
    metrics.neverUsedServers.length === 0
      ? "Every declared server has been called at least once."
      : "Every tool a server offers is described in the prompt of every run. These have " +
          "never been called:\n\n" +
          metrics.neverUsedServers.map((t) => `- \`${t}\``).join("\n"),
  );
  out.push("");

  out.push("## Shell activity");
  out.push("");
  out.push(
    "What the agents do when they reach for a shell. `search` without a matching `open` is " +
      "the shape that produced this project's most expensive runs; `edit` against `verify` is " +
      "the shape that turned out not to occur at all.",
  );
  out.push("");
  out.push(...tallyTable(metrics.byAct, metrics.byAct.reduce((s, a) => s + a.count, 0), "act", "calls"));
  out.push("");
  out.push(`Hooks refused ${n(metrics.refusals)} calls.`);
  out.push("");

  out.push("## Skills");
  out.push("");
  out.push(...tallyTable(metrics.bySkill, metrics.bySkill.reduce((s, k) => s + k.count, 0), "skill", "loads"));
  out.push("");
  out.push("### Never loaded");
  out.push("");
  out.push(
    metrics.neverLoaded.length === 0
      ? "Every skill has been loaded at least once."
      : "Each of these is described in the prompt of every run and has never been loaded. That " +
          "is either a skill nobody needs or one the prompt fails to point at:\n\n" +
          metrics.neverLoaded.map((s) => `- \`${s}\``).join("\n"),
  );
  out.push("");

  return out.join("\n");
}

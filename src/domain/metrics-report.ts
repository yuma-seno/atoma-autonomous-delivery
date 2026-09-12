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
 * `generatedAt` is passed in rather than read from the clock so the same input renders
 * the same output — which is what lets a test assert on it, and what keeps a rerun that
 * changed nothing from producing a commit.
 */
export function renderReport(metrics: Metrics, generatedAt: string): string {
  const out: string[] = [];

  out.push("# Agent metrics");
  out.push("");
  out.push(
    `Read from ${n(metrics.sessions)} stored sessions on this branch. Nothing here is recorded ` +
      "specially: every number is something the agents already wrote down while working.",
  );
  out.push("");
  out.push(`Generated ${generatedAt}.`);
  out.push("");

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

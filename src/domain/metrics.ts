/**
 * metrics.ts — what the stored sessions say about how the agents are being run.
 *
 * ## Reading rather than recording
 *
 * Nothing here asks for a new record to be kept. Every number below is already in
 * `atoma-data`: a session holds every tool call an agent made, in order, with the
 * arguments it passed and the result it got back. Half the work turned out to be
 * reading what is there, and the week that followed proved it three times — the search
 * guard's threshold, the cause of a 6.4M-token run, and the finding that the
 * edit/verify loop does not occur at all were each read out of these files.
 *
 * That is also why sessions are kept permanently. An aggregate answers the
 * questions it was built to answer. The raw sessions answer the ones nobody has thought
 * of yet, and all three of those started as questions nobody had thought of.
 *
 * ## What is deliberately not here
 *
 * **Money.** Four providers, and only one of them reports a cost; a price table goes
 * quietly stale and then prints confident wrong numbers. Tokens are the axis instead:
 * measured, comparable across providers, and anybody who knows their own rate can
 * multiply. Cost display was removed elsewhere for the same reason.
 *
 * **Averages, where a distribution is the point.** One run spent 54M tokens. Any mean
 * containing it describes nothing; the percentiles say what a normal run costs and what
 * the tail looks like, separately.
 */

/** One tool call, as the aggregation needs it. */
export interface CallRecord {
  tool: string;
  /** The agent that made it, from the session's own metadata. */
  agent: string;
  /** Whether the result came back as an error. */
  failed: boolean;
  /** For `atoma_builtin__load_skill`, the skill named. */
  skill?: string;
  /** For a shell call, what the command was doing. */
  act?: ShellAct;
  /** Whether a hook refused the call. */
  refused: boolean;
}

/** What a shell command was doing, coarsely. The categories the guard proposals argue about. */
export type ShellAct = "search" | "open" | "edit" | "verify" | "other";

/** One stored session, reduced to what is counted. */
export interface SessionRecord {
  path: string;
  agent: string;
  messages: number;
  calls: CallRecord[];
}

/** One run's token usage, read from the result comment it posted. */
export interface TokenRecord {
  issue: number;
  total: number;
  prompt: number;
  completion: number;
}

/** Everything the report is rendered from. */
export interface Metrics {
  sessions: number;
  messages: Distribution;
  byAgent: Tally[];
  byTool: FailureTally[];
  bySkill: Tally[];
  byAct: Tally[];
  /** Declared servers that nothing called. See `metricsOf` for why servers and not tools. */
  neverUsedServers: string[];
  neverLoaded: string[];
  refusals: number;
  tokens?: TokenSummary;
}

export interface Tally {
  name: string;
  count: number;
}

export interface FailureTally extends Tally {
  failed: number;
}

export interface Distribution {
  p50: number;
  p90: number;
  p99: number;
  max: number;
  total: number;
}

export interface TokenSummary {
  runs: number;
  total: number;
  perRun: Distribution;
  /** Prompt as a share of total, 0-1. Measured at 97-99%, which is the point. */
  promptShare: number;
}

/**
 * A percentile, by the nearest-rank rule on a sorted copy.
 *
 * Not interpolated: these are counts of discrete things, and "the 90th run spent 90,000
 * tokens" is a sentence about a run that happened. An interpolated value is not.
 */
export function distributionOf(values: readonly number[]): Distribution {
  if (values.length === 0) return { p50: 0, p90: 0, p99: 0, max: 0, total: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return {
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    total: values.reduce((sum, v) => sum + v, 0),
  };
}

function tally(names: readonly string[]): Tally[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
.map(([name, count]) => ({ name, count }))
.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Everything the report shows, from the sessions and what the runs reported.
 *
 * `declaredServers` and `declaredSkills` are what the repository offers, so the report can
 * name what is never used. That is the metric with a cost attached: a server's tools and
 * a skill's description are in the prompt of every single run, so something never used is
 * paid for every time and returns nothing.
 *
 * Servers rather than individual tools, because `tools.yaml` declares servers and only a
 * running server can list its tools. Comparing the declared names against call names
 * directly is what the first version did, and since a call is `filesystem__read_text_file`
 * and the declaration is `filesystem`, it reported every server as unused.
 */
export function metricsOf(
  sessions: readonly SessionRecord[],
  declaredServers: readonly string[],
  declaredSkills: readonly string[],
  tokens: readonly TokenRecord[],
): Metrics {
  const calls = sessions.flatMap((s) => s.calls);
  const byTool = new Map<string, FailureTally>();
  for (const call of calls) {
    const row = byTool.get(call.tool) ?? { name: call.tool, count: 0, failed: 0 };
    row.count += 1;
    if (call.failed) row.failed += 1;
    byTool.set(call.tool, row);
  }

  const usedServers = new Set(calls.map((c) => c.tool.split("__")[0] ?? ""));
  const loaded = new Set(calls.flatMap((c) => (c.skill ? [c.skill] : [])));

  return {
    sessions: sessions.length,
    messages: distributionOf(sessions.map((s) => s.messages)),
    byAgent: tally(sessions.map((s) => s.agent)),
    byTool: [...byTool.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    bySkill: tally(calls.flatMap((c) => (c.skill ? [c.skill] : []))),
    byAct: tally(calls.flatMap((c) => (c.act ? [c.act] : []))),
    neverUsedServers: declaredServers.filter((s) => !usedServers.has(s)).sort(),
    neverLoaded: declaredSkills.filter((s) => !loaded.has(s)).sort(),
    refusals: calls.filter((c) => c.refused).length,
    tokens: tokens.length === 0 ? undefined : tokenSummary(tokens),
  };
}

function tokenSummary(tokens: readonly TokenRecord[]): TokenSummary {
  const total = tokens.reduce((sum, t) => sum + t.total, 0);
  const prompt = tokens.reduce((sum, t) => sum + t.prompt, 0);
  return {
    runs: tokens.length,
    total,
    perRun: distributionOf(tokens.map((t) => t.total)),
    promptShare: total === 0 ? 0 : prompt / total,
  };
}

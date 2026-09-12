import { describe, expect, test } from "bun:test";
import { distributionOf, metricsOf, type CallRecord, type SessionRecord } from "./metrics.ts";
import { renderReport } from "./metrics-report.ts";

const call = (tool: string, extra: Partial<CallRecord> = {}): CallRecord => ({
  tool,
  agent: "engineer",
  failed: false,
  refused: false,
  ...extra,
});

const SESSIONS: SessionRecord[] = [
  {
    path: "sessions/issue-1/engineer.json",
    agent: "engineer",
    messages: 10,
    runs: [],
    calls: [
      call("shell__shell_execute", { act: "search" }),
      call("shell__shell_execute", { act: "open" }),
      call("filesystem__read_text_file"),
      call("atoma_builtin__load_skill", { skill: "engineering/tdd" }),
      call("github__create_pr", { failed: true }),
      call("shell__shell_execute", { act: "edit", refused: true }),
    ],
  },
  { path: "sessions/issue-2/reviewer.json", agent: "reviewer", messages: 40, runs: [], calls: [call("github__get_pr")] },
];

const SERVERS = ["shell", "filesystem", "github", "web", "search"];
const SKILLS = ["engineering/tdd", "delivery/pipeline-setup"];
const TOKENS = [
  { issue: 1, total: 1000, prompt: 980, completion: 20 },
  { issue: 2, total: 3000, prompt: 2900, completion: 100 },
];

describe("distributionOf", () => {
  /** Nearest rank, not interpolated: each of these is a thing that happened. */
  test("percentiles are values that occur", () => {
    const d = distributionOf([1, 2, 3, 4, 100]);
    expect([d.p50, d.max, d.total]).toEqual([3, 100, 110]);
  });

  test("nothing measured is not an error", () => {
    expect(distributionOf([])).toEqual({ p50: 0, p90: 0, p99: 0, max: 0, total: 0 });
  });
});

describe("metricsOf", () => {
  const metrics = metricsOf(SESSIONS, SERVERS, SKILLS, TOKENS);

  /**
   * The defect the first run against real data exposed. `tools.yaml` declares servers
   * (`filesystem`) and a call names a tool (`filesystem__read_text_file`), so comparing
   * the two directly reported every server as unused -- a section of confident nonsense.
   */
  test("an unused server is one whose tools nothing called", () => {
    expect(metrics.neverUsedServers).toEqual(["search", "web"]);
  });

  test("an unloaded skill is named, since it is described in every prompt", () => {
    expect(metrics.neverLoaded).toEqual(["delivery/pipeline-setup"]);
  });

  test("failures and refusals are counted apart", () => {
    expect(metrics.byTool.find((t) => t.name === "github__create_pr")?.failed).toBe(1);
    expect(metrics.refusals).toBe(1);
  });

  test("shell acts are tallied, which is where the guard arguments live", () => {
    expect(metrics.byAct.map((a) => a.name).sort()).toEqual(["edit", "open", "search"]);
  });

  /** 97-99% measured, every time. It is why prompt is where savings come from. */
  test("the prompt share is reported", () => {
    expect(Math.round((metrics.tokens?.promptShare ?? 0) * 1000) / 10).toBe(97);
  });

  test("no run reporting tokens means no token section rather than zeroes", () => {
    expect(metricsOf(SESSIONS, SERVERS, SKILLS, []).tokens).toBeUndefined();
  });
});

describe("renderReport", () => {
  const NOW = new Date("2026-09-13T00:00:00Z");
  const report = renderReport(metricsOf(SESSIONS, SERVERS, SKILLS, TOKENS), NOW);

  /**
   * Each table counts a different thing, and the first version labelled all of them
   * "calls" -- so the agent table read as though `reviewer` had made 236 calls when it
   * had run 236 times.
   */
  test("every table says what it is counting", () => {
    expect(report).toContain("| agent | sessions | share |");
    expect(report).toContain("| skill | loads | share |");
    expect(report).toContain("| act | calls | share |");
  });

  test("it names the servers and skills nothing used", () => {
    expect(report).toContain("### Servers never used");
    expect(report).toContain("- `web`");
    expect(report).toContain("- `delivery/pipeline-setup`");
  });

  /** No money, deliberately: see the module comment. */
  test("it reports tokens and never a cost", () => {
    expect(report).toContain("4,000 tokens");
    expect(report).not.toMatch(/[$€£]\d/);
  });

  /**
   * The date is passed in rather than read from the clock, so a rerun that changed
   * nothing produces no commit.
   */
  test("the same input renders the same output", () => {
    expect(renderReport(metricsOf(SESSIONS, SERVERS, SKILLS, TOKENS), NOW)).toBe(report);
  });
});

/**
 * The section that answers "is this getting better or worse", which is the question
 * dogfooding exists to ask and the only one an all-time table cannot answer.
 */
describe("the run windows", () => {
  const NOW = new Date("2026-09-13T12:00:00Z");
  const run = (ended: string, why = "completed", seconds = 60) => ({
    started: ended,
    ended,
    seconds,
    ended_because: why,
    messages: 20,
  });
  const withRuns = (runs: ReturnType<typeof run>[]) => [
    { path: "a", agent: "engineer", messages: 10, runs, calls: [] },
  ];

  /**
   * The state this repository is in until atoma v0.1.28 has run. An omitted section
   * would read as "nothing went wrong"; this says what is actually true.
   */
  test("no recorded run says so rather than showing empty tables", () => {
    const report = renderReport(metricsOf(withRuns([]), [], [], []), NOW);
    expect(report).toContain("No run has recorded itself yet");
    expect(report).not.toContain("| window |");
  });

  test("a run counts in every window that reaches it", () => {
    const report = renderReport(
      metricsOf(withRuns([run("2026-09-13T00:00:00Z"), run("2026-08-01T00:00:00Z", "failed")]), [], [], []),
      NOW,
    );
    expect(report).toContain("| Last 7 days | 1 |");
    expect(report).toContain("| All time | 2 |");
  });

  /** An empty window is a row, not a gap, so the reader can see it was asked. */
  test("a window with nothing in it is still a row", () => {
    expect(renderReport(metricsOf(withRuns([run("2026-01-01T00:00:00Z")]), [], [], []), NOW)).toContain(
      "| Last 7 days | 0 | — | — | — |",
    );
  });

  test("every ending that is not completed counts as giving up", () => {
    const report = renderReport(
      metricsOf(
        withRuns([run("2026-09-13T00:00:00Z"), run("2026-09-13T00:00:00Z", "iterations")]),
        [],
        [],
        [],
      ),
      NOW,
    );
    expect(report).toContain("| Last 7 days | 2 | 50% |");
    expect(report).toContain("| `iterations` | 1 |");
  });
});

/**
 * server-reports.test.ts — the servers this repository ships report over the
 * protocol, and their log lines do not pretend to.
 *
 * atoma has two channels for a server's trouble (atoma#13). `notifications/message`
 * carries a level the server chose; a spawned server's stderr is the fallback, and
 * severity there is read out of the words — `warn`, `warning`, `error`, `fatal`,
 * `panic`. That guess fails in both directions, and #519 is about not relying on it
 * for the servers we own.
 *
 * Which leaves one thing a test can hold: **a log line in a shipped server must not
 * contain a severity word.** If it does, one of two things is true and both are
 * wrong —
 *
 *   - it is a report, and it should go through `lib/mcp-report.ts`
 *   - it is not, and the fallback will put it in front of an agent as a problem
 *
 * The scope is `src/atoma/tools/scripts/**`, which is code that only ever runs as a
 * tool server. `src/lib/**` is deliberately outside it: those functions are called
 * from workflow scripts too, where there is no protocol channel and a WARN on
 * stderr is what a person reads in the run log. Their lines still reach the
 * fallback when a server calls them, which is the behaviour that already existed.
 *
 * Only literal text is checked. A message that interpolates an error can always
 * contain the word "error", and nothing here can prevent that.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_DIRS = [
  "src/atoma/tools/scripts/mcp",
  "src/atoma/tools/scripts/lib",
  "src/atoma/tools/scripts/hooks",
];

/** The words atoma's stderr fallback reads severity out of. */
const SEVERITY = /\b(warn|warning|warnings|error|errors|fatal|panic)\b/i;

function serverFiles(): string[] {
  const files: string[] = [];
  for (const dir of SERVER_DIRS) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(join(dir, name));
    }
  }
  return files;
}

/**
 * The literal text of every `log(...)` call, without what is interpolated into it.
 *
 * Deliberately simple: it reads the first line of each call, which is where the
 * fixed words are. A message assembled somewhere else and passed in as a variable
 * is not reachable this way, and that is a limit rather than a hole -- the failure
 * this guards against is somebody typing `log("WARN ...")` out of habit.
 */
function logLiterals(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const match = /\blog\(\s*([`"'])([^`"']*)/.exec(trimmed);
    if (match) found.push(match[2] ?? "");
  }
  return found;
}

describe("what a shipped tool server says about itself", () => {
  test("no log line carries a severity word the fallback would read", () => {
    const offenders: string[] = [];
    for (const file of serverFiles()) {
      for (const text of logLiterals(readFileSync(file, "utf8"))) {
        if (SEVERITY.test(text)) offenders.push(`${file}: log("${text}...")`);
      }
    }
    expect(
      offenders,
      "either report it through lib/mcp-report.ts, or drop the word so the fallback does not promote it",
    ).toEqual([]);
  });

  /**
   * And the channel is actually used. A repository that removed every severity word
   * and reported nothing would pass the test above and be worse than where it
   * started -- the reports would simply be gone.
   */
  test("the servers do report, through the one channel", () => {
    // The texts rather than the call shape: a formatter is free to move the
    // arguments onto their own lines, and a test that broke when it did would be
    // testing the formatter.
    const expected: [string, string[]][] = [
      [
        "src/atoma/tools/scripts/mcp/search.ts",
        [
          // #499 itself, and the line that says the answer is worse.
          "could not preload the reranker",
          "first-stage ordered, not reranked",
        ],
      ],
      [
        "src/atoma/tools/scripts/lib/harden.ts",
        ["this process could not become unreadable"],
      ],
      [
        "src/atoma/tools/scripts/mcp/github.ts",
        ["CI validation was NOT dispatched"],
      ],
    ];

    for (const [file, texts] of expected) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must import the channel`).toContain("lib/mcp-report.ts");
      for (const text of texts) {
        expect(source, `${file} must still say: ${text}`).toContain(text);
        // And must not say it through the other channel. A revert to `log()` would
        // leave the text in place and the report gone.
        for (const line of source.split("\n")) {
          if (line.includes(text) && /\blog\(/.test(line)) {
            throw new Error(`${file} reports "${text}" through log(), not report()`);
          }
        }
      }
    }
  });

  /**
   * Declared, or `sendLoggingMessage` is a silent no-op: the SDK checks its own
   * capabilities and returns without sending. Nothing would fail, and every report
   * would stop arriving.
   */
  test("the server declares the capability that makes a report possible", () => {
    const serving = readFileSync("src/lib/mcp-tool.ts", "utf8");
    expect(serving).toContain("capabilities: { tools: {}, logging: {} }");
    expect(serving, "and points reports at the connection once it is up").toContain(
      "attachReportChannel(",
    );
  });
});

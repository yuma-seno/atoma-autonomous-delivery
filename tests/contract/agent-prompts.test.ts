import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("agent prompt contracts", () => {
  test("uses orchestrator-first delegation with an explicit engineer leaf gate", () => {
    const orchestrator = readFileSync("src/atoma/agent-definitions/orchestrator.md", "utf8");
    expect(orchestrator).toContain("assign them to `orchestrator` by default");
    expect(orchestrator).toContain("only when it satisfies every leaf condition");
    expect(orchestrator).toContain("File count and apparent effort do not determine leaf status");
  });

  test("prevents engineers from implementing unresolved non-leaf work", () => {
    const engineer = readFileSync("src/atoma/agent-definitions/engineer.md", "utf8");
    expect(engineer).toContain("If it is not engineer-ready, do not edit");
    expect(engineer).toContain("Return `/orchestrator` on the first line");
  });

  test("loads procedures as skills without requesting visible chain of thought", () => {
    const reviewer = readFileSync("src/atoma/agent-definitions/reviewer.md", "utf8");
    const prompt = readFileSync("src/atoma/prompt-template.md", "utf8");
    expect(reviewer).toContain("Load `review/quick-quality-gate`");
    expect(prompt).toContain("Load each relevant skill with `atoma_builtin__load_skill`");
    expect(prompt).toContain("Reason privately");
    expect(prompt).not.toContain("Before taking action or generating final output, always use the `<thought>` tag");
  });

  test("requires agent handoff directives to occupy their own line", () => {
    const prompt = readFileSync("src/atoma/prompt-template.md", "utf8");
    const orchestrator = readFileSync("src/atoma/agent-definitions/orchestrator.md", "utf8");
    expect(prompt).toContain("directive line must contain only `/agent-name`");
    expect(orchestrator).toContain("Return `/engineer` on its own line");
  });

  // Pins the two rules the agents were observed breaking, because each failure
  // looked like success: the reviewer answered `LGTM` in prose and merged nothing,
  // and it announced that it would wait for a check with nothing able to resume
  // the run. Both are properties of the wording, so they belong in a test.
  test("tells every agent that an outcome is a tool call and that it cannot wait", () => {
    const prompt = readFileSync("src/atoma/prompt-template.md", "utf8");
    // Single-line substrings on purpose: these files are wrapped prose, and a
    // phrase spanning a line break also picks up whatever indentation wraps it.
    expect(prompt).toContain("outcome means making that call");
    expect(prompt).toContain("You cannot wait");
  });

  // The reviewer is the one agent whose outcomes were prose-classified rather than
  // a numbered procedure ending in a named call, and the one that failed to act.
  test("gives the reviewer an ordered procedure that names the merge calls", () => {
    const reviewer = readFileSync("src/atoma/agent-definitions/reviewer.md", "utf8");
    expect(reviewer).toContain("Do this before deciding");
    expect(reviewer).toContain("without making them merges nothing");
    // `checks-missing` used to say "call check_merge_readiness again", which no
    // agent can do usefully -- the check it is waiting on outlives the run.
    expect(reviewer).toContain("you cannot wait for it");
  });
});

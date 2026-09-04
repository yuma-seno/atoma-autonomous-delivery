import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WORKSPACE_PATH } from "../../src/domain/workspace.ts";

describe("agent prompt contracts", () => {
  test("uses orchestrator-first delegation with an explicit engineer leaf gate", () => {
    const orchestrator = readFileSync("src/atoma/agent-definitions/orchestrator.md", "utf8");
    expect(orchestrator).toContain("assign them to `orchestrator` by default");
    expect(orchestrator).toContain("only when it satisfies every leaf condition");
    expect(orchestrator).toContain("File count and apparent effort do not determine leaf status");
  });

  /**
   * The outcome that did not exist, and the run that measured its absence (#544).
   *
   * The engineer's `Outcome` table was five rows, all of them "implement and open a
   * pull request" or "refuse". Asked for an inventory, it spent 200 iterations and
   * 324 shell calls and posted nothing -- because there was no outcome to arrive at.
   * The shared template says a run asked to investigate is not blocked on anything;
   * the engineer's own contract overrode that with a seven-step pipeline to a PR.
   *
   * Pinned because the failure is invisible: a run that never arrives looks like a
   * run that is still working, right up to the iteration limit.
   */
  test("an engineer asked a question has somewhere to arrive", () => {
    const engineer = readFileSync("src/atoma/agent-definitions/engineer.md", "utf8");
    expect(engineer, "the outcome table must offer answering as an outcome").toContain(
      "The request is a question rather than a change",
    );
    // And a rule for when to stop looking, which is the other half: an outcome you
    // can reach is no use if nothing says when you have enough to reach it.
    expect(engineer).toContain("An investigation ends when you can answer what was asked");
    expect(engineer).toContain("write what you have and name what you could not establish");
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

  /**
   * The sentence #514 turns on, in both places an agent reads it.
   *
   * A tool server can now say it answered worse than it should have (atoma#13), and
   * the same warning produces two very different runs depending on what the agent
   * concludes: "my query was poor" ends in trying again differently, and "the
   * reranker is not running" ends in an issue. The second was the truth in #499 and
   * the first is what an agent asked whether something went badly reaches for, because
   * its own conduct is what it has been told to examine.
   *
   * So the attribution is not a nicety of wording -- it is the whole mechanism. Pinned
   * the way the reviewer's two rules above are pinned: the failure looks like success,
   * because a run that files an apology instead of a defect still reads as a run that
   * noticed something.
   */
  test("says a problem a tool reported about itself is not the agent's failure", () => {
    for (const file of ["src/atoma/prompt-template.md", "src/atoma/skills/engineering/environment.md"]) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} must not let a tool's degradation read as the agent's fault`).toContain(
        "not a failure of your work",
      );
    }
  });

  /**
   * And the skill has to close the loop, not just absolve the agent. `docs/edd.md`
   * names the failure this is against: "Whoever observed the gap cannot propose the
   * fix, so it waits until someone else notices." The run that saw the warning is the
   * only one holding it, so filing is part of seeing it.
   *
   * `sub_issue: false` because the default is true: a defect in the tools would
   * otherwise be filed as a child of whatever the agent happened to be working on,
   * and disappear when that issue closed.
   */
  test("the environment skill turns a reported problem into a filed issue", () => {
    const skill = readFileSync("src/atoma/skills/engineering/environment.md", "utf8");
    expect(skill).toContain("github__create_issue");
    expect(skill, "a tool defect is not a child of the current issue").toContain("sub_issue: false");
  });

  /**
   * The scratch workspace's path is stated in three places and has to be one path.
   *
   * `domain/workspace.ts` holds it, the runner mounts it there, the prompt template
   * tells the agent about it, and `shell_execute`'s description repeats it. Both of
   * the last two, because a tool's own description was measured to carry more weight
   * than the same words in the system prompt (#325) -- and this sentence has to hold
   * at the moment the agent is deciding where to put a file, which is when it is
   * reading the tool.
   *
   * A path that drifted in one of them would be an agent writing somewhere real,
   * being told it persists, and finding it gone -- the exact shape of failure the
   * workspace exists to remove.
   */
  test("the scratch workspace is named identically wherever an agent reads about it", () => {
    for (const file of ["src/atoma/prompt-template.md", "src/atoma/tools/scripts/mcp/shell.ts"]) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} must name the workspace`).toContain(WORKSPACE_PATH);
      // Both halves. "This survives" alone invites leaving working files in the
      // repository as well; "nothing else survives" alone does not say where to
      // put them.
      expect(text.toLowerCase(), `${file} must say it survives`).toMatch(/survive/);
      expect(text, `${file} must say what happens to files left in the repository`).toMatch(/committed/);
    }
  });

  /**
   * And nothing may tell an agent to expand a variable to find it. `ls
   * $ATOMA_WORKSPACE` with the variable unset returns nothing, which reads exactly
   * like an empty directory -- so the failure and the ordinary case become
   * indistinguishable in the one place a model is looking.
   */
  test("the workspace is never named through a variable", () => {
    for (const file of ["src/atoma/prompt-template.md", "src/atoma/tools/scripts/mcp/shell.ts"]) {
      expect(readFileSync(file, "utf8"), `${file}`).not.toContain("ATOMA_WORKSPACE");
    }
  });
});

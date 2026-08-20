/**
 * deliverable-integrity.test.ts — the rules that decide whether a `.github/atoma/`
 * can start a run.
 *
 * Every case here is a name that resolves to nothing, or a setting that would be
 * read as absent. That is the shape of the whole class: none of it fails loudly on
 * its own, which is why it needed a check.
 */
import { describe, expect, test } from "bun:test";
import { configProblems, knownConfigKeys } from "./deliverable-integrity.ts";
import { DEFAULT_CD_WORKFLOW, DEFAULT_CI_WORKFLOW } from "./shipped-workflows.ts";

/** The shipped configuration, near enough: consistent, and the baseline for each case. */
const SOUND = {
  merge_policy: "auto",
  environment: { setup_commands: [] },
  checks: { commands: [], secrets: [] },
  deploy: { targets: [], secrets: [] },
  tools: { secrets: [] },
  agents: { orchestrator: { max_iterations: 100 }, engineer: { max_iterations: 200 } },
  labels: { in_progress: "atoma/in-progress" },
  auto_triggers: [{ event: "pull_request.opened", agent: "reviewer" }],
};

const facts = (config: unknown) => ({
  config,
  agentNames: ["engineer", "orchestrator", "reviewer"],
  workflowFiles: [DEFAULT_CI_WORKFLOW, DEFAULT_CD_WORKFLOW, "atoma-runner.yml"],
});

const problemsFor = (config: unknown) => configProblems(facts(config));

describe("a sound deliverable", () => {
  test("reports nothing", () => {
    expect(problemsFor(SOUND)).toEqual([]);
  });

  // The shipped file sets almost nothing. Absent is not the same as invalid, and a
  // check that could not tell them apart would fail every fresh adoption.
  test("an almost-empty config is sound", () => {
    expect(problemsFor({})).toEqual([]);
  });
});

describe("keys nothing reads", () => {
  test("a misspelled top-level key is reported", () => {
    const problems = problemsFor({ ...SOUND, governed_path: ["docs/**"] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`governed_path`");
  });

  // The nested form is exactly as silent and rather more likely: the reader asks
  // for `checks.commands`, finds nothing, and runs no commands.
  test("a misspelled nested key is reported with its path", () => {
    const problems = problemsFor({ ...SOUND, checks: { command: ["bun test"] } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`checks.command`");
  });

  // `agents` names the project's agents, so no name there can be wrong in itself —
  // only its interior can be, and only against a definition that exists.
  test("an agent name is not a misspelled key, but its interior is checked", () => {
    expect(problemsFor({ ...SOUND, agents: { reviewer: { max_iterations: 5 } } })).toEqual([]);
    const problems = problemsFor({ ...SOUND, agents: { reviewer: { max_iteration: 5 } } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`agents.reviewer.max_iteration`");
  });

  // `labels` has an index signature: a project may name labels of its own, and
  // those are not typos.
  test("a project's own label name is legal", () => {
    expect(problemsFor({ ...SOUND, labels: { in_progress: "wip", needs_design: "design" } })).toEqual([]);
  });

  test("a config that is not an object is reported once", () => {
    expect(problemsFor([])).toHaveLength(1);
    expect(problemsFor("x")).toHaveLength(1);
  });
});

/**
 * The resolvers this module runs are the ones that already run — just later. Each
 * case here is a configuration that resolves to "nothing configured" today, at
 * merge, deploy or credential-handout time, with nothing said at pull-request time.
 */
describe("the resolvers, run early", () => {
  // The worst of the set: ONE bad entry resolves the WHOLE list to empty, so every
  // trigger stops firing and no event dispatches anything.
  test("a bad auto_triggers entry is reported", () => {
    const problems = problemsFor({ ...SOUND, auto_triggers: [{ event: "pull_request.opened" }] });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("auto_triggers[0]");
  });

  test("an unknown trigger condition is reported", () => {
    const problems = problemsFor({
      ...SOUND,
      auto_triggers: [{ event: "pull_request_review.submitted", agent: "engineer", condition: "changes-requested" }],
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  test("a malformed merge gate is reported", () => {
    expect(problemsFor({ ...SOUND, merge_gates: [{ reason: "r", when: { title_match: "^x" } }] }).length).toBeGreaterThan(
      0,
    );
  });

  test("a malformed deploy target is reported", () => {
    expect(problemsFor({ ...SOUND, deploy: { targets: [{ name: "Prod" }] } }).length).toBeGreaterThan(0);
  });

  // A declared credential that collides with one the run needs for itself would
  // replace it. Today that fails the run; here it fails the pull request.
  test("a reserved credential name is reported for every destination", () => {
    for (const [section, key] of [
      ["tools", "secrets"],
      ["checks", "secrets"],
      ["deploy", "secrets"],
    ] as const) {
      const problems = problemsFor({ ...SOUND, [section]: { [key]: ["GH_TOKEN"] } });
      expect(problems.length, section).toBeGreaterThan(0);
    }
  });
});

describe("names that have to resolve to a file", () => {
  test("a trigger routing to a nonexistent agent is reported", () => {
    const problems = problemsFor({
      ...SOUND,
      auto_triggers: [{ event: "pull_request.opened", agent: "reviwer" }],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("reviwer");
    expect(problems[0]).toContain("agent-definitions/reviwer.md");
  });

  // `$dispatch_agent` and friends are filled in from the event, so there is no
  // name here to look for. Reporting one would refuse the shipped configuration.
  test("a runtime-resolved agent is not looked up", () => {
    expect(
      problemsFor({
        ...SOUND,
        auto_triggers: [{ event: "issue_comment.created", agent: "$dispatch_agent", condition: "atoma:dispatch" }],
      }),
    ).toEqual([]);
  });

  test("an iteration budget for an agent that does not exist is reported", () => {
    const problems = problemsFor({ ...SOUND, agents: { enginer: { max_iterations: 200 } } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`agents.enginer`");
  });

  // Without definitions there is nothing to resolve against, and reporting every
  // name as missing would bury the one problem that matters.
  test("no agent definitions at all is one problem, not one per name", () => {
    const problems = configProblems({ ...facts(SOUND), agentNames: [] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("agent-definitions");
  });
});

describe("the workflows a dispatch names", () => {
  test("a configured workflow that is not a file is reported", () => {
    const problems = problemsFor({ ...SOUND, workflows: { ci: "ci.yml" } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("ci.yml");
  });

  test("the shipped defaults are what an unset value resolves to", () => {
    const problems = configProblems({ ...facts(SOUND), workflowFiles: ["atoma-runner.yml"] });
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain(DEFAULT_CI_WORKFLOW);
    expect(problems.join(" ")).toContain(DEFAULT_CD_WORKFLOW);
  });

  // A repository whose workflows were not listed — because this ran somewhere the
  // directory does not exist — must not report both defaults as missing.
  test("an unreadable workflow directory checks nothing", () => {
    expect(configProblems({ ...facts(SOUND), workflowFiles: [] })).toEqual([]);
  });
});

describe("labels", () => {
  test("an empty label is reported", () => {
    for (const value of ["", "   ", 3, null]) {
      const problems = problemsFor({ ...SOUND, labels: { in_progress: value } });
      expect(problems, String(value)).toHaveLength(1);
      expect(problems[0], String(value)).toContain("`labels.in_progress`");
    }
  });
});

describe("knownConfigKeys", () => {
  // The projection `config-contract.test.ts` compares against the interface. Held
  // here too, because a shape change there would otherwise be diagnosed as a
  // mismatch with the type rather than as a change to this function.
  test("renders a wildcard level as `*` and descends through it", () => {
    const keys = knownConfigKeys();
    expect(keys).toContain("agents.*.max_iterations");
    expect(keys).toContain("labels.*");
    expect(keys).toContain("labels.in_progress");
    expect(keys).toContain("checks.commands");
    expect(keys).toEqual([...keys].sort());
  });
});

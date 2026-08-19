/**
 * Every job that runs a project's own commands sets that project's environment up
 * first.
 *
 * The failure this prevents is not a broken build. It is a build that passes for
 * the agent and fails in CI, on a machine the agent cannot see, which comes back
 * to an engineer as a defect that does not reproduce -- and `CI_RETRY_LIMIT`
 * spends three inferences on it before a human hears about it. #398.
 *
 * Pinned against the generated YAML rather than the `.wac.ts`, because the
 * generated file is what an adopter receives and what actually runs. A fourth job
 * that runs project commands should fail this test until it includes the step.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SETUP_STEP = "Run configured environment setup";

/** The three jobs, and the step in each that runs what the project declared. */
const JOBS = [
  {
    workflow: "atoma-runner",
    job: "run",
    projectCommands: "Run agent",
    why: "the agent's own shell, which is the environment every other one is compared against",
  },
  {
    workflow: "atoma-check",
    job: "atoma-check",
    projectCommands: "Run the configured checks",
    why: "the verdict a pull request merges on",
  },
  {
    workflow: "atoma-deploy",
    job: "deploy",
    projectCommands: "Deploy the targets this run is for",
    why: "the least frequent and the most expensive to get wrong",
  },
] as const;

interface WorkflowDocument {
  jobs?: Record<string, { steps?: { name?: string; run?: string }[] }>;
}

function stepNames(workflow: string, job: string): string[] {
  const doc = Bun.YAML.parse(
    readFileSync(`dist/.github/workflows/${workflow}.yml`, "utf8"),
  ) as WorkflowDocument;
  const steps = doc.jobs?.[job]?.steps;
  expect(steps, `${workflow}.yml has no job named ${job}`).toBeDefined();
  return (steps ?? []).map((step) => step.name ?? "");
}

describe("environment setup reaches every job that runs project commands", () => {
  for (const { workflow, job, projectCommands, why } of JOBS) {
    test(`${workflow} sets the environment up before "${projectCommands}"`, () => {
      const names = stepNames(workflow, job);
      const setup = names.indexOf(SETUP_STEP);
      const commands = names.indexOf(projectCommands);

      expect(setup, `${workflow} runs ${why} without setting the environment up`).toBeGreaterThan(-1);
      expect(commands, `${workflow} no longer has a step named "${projectCommands}"`).toBeGreaterThan(-1);
      expect(
        setup,
        `in ${workflow}, setup runs after the commands that need it`,
      ).toBeLessThan(commands);
    });
  }

  // Setup runs a project's commands, and a project's commands are not the place
  // for a credential nobody asked to expose. In the agent's run this is load
  // bearing -- the whole confinement in #374 rests on secrets not being in the
  // environment when third-party build code runs -- and in the other two it falls
  // out of step order. Either way, nothing should quietly add one.
  test("setup runs before any secret enters the environment", () => {
    for (const { workflow, job } of JOBS) {
      const names = stepNames(workflow, job);
      const setup = names.indexOf(SETUP_STEP);
      const secrets = names.indexOf("Resolve which repository secrets may reach this run");
      if (secrets === -1) continue;
      expect(setup, `${workflow} resolves secrets before running setup commands`).toBeLessThan(secrets);
    }
  });
});

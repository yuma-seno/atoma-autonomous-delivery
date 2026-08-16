import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../../src/lib/session.ts";
import {
  TOOL_SECRET_NAMES_VAR,
  TOOL_SECRET_SLOT_PREFIX,
  TOOL_SECRET_SLOTS,
} from "../../src/domain/tool-secrets.ts";

describe("generated workflows", () => {
  test("routes recover mode and reports invalid command syntax", () => {
    type WorkflowStep = { name?: string; run?: string };
    type WorkflowDocument = {
      on?: { workflow_call?: { inputs?: Record<string, unknown> } };
      jobs?: Record<string, { outputs?: Record<string, string>; with?: Record<string, string>; steps?: WorkflowStep[] }>;
    };

    const manual = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-manual-comment.yml", "utf8")) as WorkflowDocument;
    expect(manual.jobs?.parse?.outputs?.session_mode).toContain("session_mode");
    expect(manual.jobs?.run?.with?.session_mode).toContain("session_mode");
    expect(manual.jobs?.parse?.steps?.some((step) => step.name === "Report invalid slash command")).toBe(true);

    const runner = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8")) as WorkflowDocument;
    expect(runner.on?.workflow_call?.inputs?.session_mode).toBeDefined();
    const restore = runner.jobs?.run?.steps?.find((step) => step.name === "Restore agent session from atoma-data");
    expect(restore?.run).toContain('--session-mode "${{ inputs.session_mode }}"');
  });

  // The runner may resume a branch but must never create one: a run that only
  // reports or closes something would otherwise leave a branch behind, which is
  // how the repository accumulated 72 of them. Creation belongs to the first
  // commit, in `commit_and_push`.
  test("checks out the branch a run starts from without creating one", () => {
    type WorkflowStep = { name?: string; run?: string };
    type WorkflowDocument = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

    const workflow = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8")) as WorkflowDocument;
    const steps = workflow.jobs?.run?.steps ?? [];
    const step = steps.find((candidate) => candidate.name === "Check out the branch this run starts from");
    expect(step, "atoma-runner issue branch step").toBeDefined();
    expect(step?.run).toContain("refs/heads/${BRANCH_NAME}:refs/remotes/origin/${BRANCH_NAME}");
    expect(step?.run).toContain('git checkout -B "${BRANCH_NAME}" "refs/remotes/origin/${BRANCH_NAME}"');
    // Falls back to the adopter's configured base branch, not to a new branch.
    expect(step?.run).toContain("base_branch");
    expect(steps.some((candidate) => /git (checkout|switch) -[bc]\b/.test(candidate.run ?? ""))).toBe(false);
  });

  // Guards a failure that is otherwise silent until a tool call is denied: Atoma
  // spawns a `before_tool` hook as a program, and a repository committed from a
  // filesystem without a POSIX exec bit records it as non-executable. The hook is
  // fail-closed, so losing the bit disables the tool entirely rather than
  // degrading it.
  test("makes tool hooks executable before the agent runs", () => {
    type WorkflowStep = { name?: string; run?: string };
    type WorkflowDocument = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

    const workflow = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8")) as WorkflowDocument;
    const steps = workflow.jobs?.run?.steps ?? [];
    const chmod = steps.findIndex((candidate) => candidate.name === "Make tool hooks executable");
    expect(chmod, "atoma-runner hook chmod step").toBeGreaterThanOrEqual(0);
    expect(steps[chmod]?.run).toContain("chmod +x");

    const agent = steps.findIndex((candidate) => candidate.name === "Run agent");
    expect(agent, "atoma-runner agent step").toBeGreaterThanOrEqual(0);
    expect(chmod, "hooks must be executable before the agent can call a tool").toBeLessThan(agent);
  });

  test("checkout the repository before running repository scripts", () => {
    type WorkflowStep = { uses?: string; run?: string };
    type WorkflowDocument = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

    const directory = "dist/.github/workflows";
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".yml"))) {
      const workflow = Bun.YAML.parse(readFileSync(join(directory, name), "utf8")) as WorkflowDocument;
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const steps = job.steps ?? [];
        const firstScript = steps.findIndex((step) => step.run?.includes(".github/scripts/"));
        if (firstScript === -1) continue;

        const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
        expect(checkout, `${name}:${jobName} must checkout before running repository scripts`).toBeGreaterThanOrEqual(0);
        expect(checkout, `${name}:${jobName} checkout order`).toBeLessThan(firstScript);
      }
    }
  });

  // Both halves of this guard a measured fact about GitHub, not a preference.
  //
  // `toJSON(secrets)` is refused by the malicious-workflow detector: a run whose
  // workflow contains it never starts, it queues for approval instead, and the
  // block is per FILE rather than per job. Reintroducing it anywhere would take
  // every adopter's automation offline, and the symptom (`action_required`, zero
  // seconds elapsed) looks nothing like a code change.
  //
  // A computed key is allowed, and is the whole reason a project can declare a
  // tool credential in config.json without editing generated YAML. If the slots
  // ever stopped being keyed off the resolve step, credentials would silently
  // stop arriving and only the tool needing one would fail.
  test("reaches tool credentials by a computed key, never by dumping the secrets context", () => {
    type WorkflowStep = { name?: string; env?: Record<string, string> };
    type WorkflowDocument = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

    const directory = "dist/.github/workflows";
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".yml"))) {
      expect(readFileSync(join(directory, name), "utf8"), `${name} must not dump the secrets context`).not.toContain(
        "toJSON(secrets)",
      );
    }

    const workflow = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8")) as WorkflowDocument;
    const steps = workflow.jobs?.run?.steps ?? [];

    const resolve = steps.findIndex((step) => step.name === "Resolve which repository secrets may reach the agent");
    const agent = steps.findIndex((step) => step.name === "Run agent");
    expect(resolve, "atoma-runner tool-secrets step").toBeGreaterThanOrEqual(0);
    expect(resolve, "the names must be resolved before the step whose env they key").toBeLessThan(agent);

    const env = steps[agent]?.env ?? {};
    for (let slot = 0; slot < TOOL_SECRET_SLOTS; slot++) {
      expect(env[`${TOOL_SECRET_SLOT_PREFIX}${slot}`], `slot ${slot}`).toBe(
        `\${{ secrets[fromJSON(steps.tool-secrets.outputs.names || '[]')[${slot}]] }}`,
      );
    }
    expect(env[TOOL_SECRET_NAMES_VAR]).toBe("${{ steps.tool-secrets.outputs.names }}");
  });

  test("authenticate the result-comment GitHub CLI call", () => {
    type WorkflowStep = { id?: string; env?: Record<string, string> };
    type WorkflowDocument = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

    const workflow = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8")) as WorkflowDocument;
    const step = workflow.jobs?.run?.steps?.find((candidate) => candidate.id === "post-result");
    expect(step, "atoma-runner post-result step").toBeDefined();
    expect(step?.env?.GH_TOKEN).toBe("${{ github.token }}");
  });
});

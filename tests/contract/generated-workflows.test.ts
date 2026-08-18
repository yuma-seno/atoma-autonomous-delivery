import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../../src/lib/session.ts";
import {
  SECRET_NAMES_VAR,
  SECRET_SLOT_PREFIX,
  SECRET_SLOTS,
} from "../../src/domain/declared-secrets.ts";
import { CHECK_JOB_NAME } from "../../src/workflows/atoma-check.wac.ts";

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
  test("reaches declared credentials by a computed key, never by dumping the secrets context", () => {
    type WorkflowStep = { name?: string; env?: Record<string, string> };
    type WorkflowDocument = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

    const directory = "dist/.github/workflows";
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".yml"))) {
      expect(readFileSync(join(directory, name), "utf8"), `${name} must not dump the secrets context`).not.toContain(
        "toJSON(secrets)",
      );
    }

    // Every workflow that carries a credential, and the step whose `env:` gets
    // the slots. Each pair is generated from the same helper, so the point of
    // checking all three is that none of them quietly stops using it.
    // The runner's carrier is the step that writes the credentials file, NOT the
    // one that runs the agent -- see the test below for why that distinction is
    // the whole point.
    const carriers = [
      { file: "atoma-runner.yml", job: "run", step: "Collect this run's credentials into a file" },
      { file: "atoma-check.yml", job: CHECK_JOB_NAME, step: "Run the configured checks" },
      { file: "atoma-deploy.yml", job: "deploy", step: "Deploy the targets this run is for" },
    ];

    for (const carrier of carriers) {
      const workflow = Bun.YAML.parse(readFileSync(join(directory, carrier.file), "utf8")) as WorkflowDocument;
      const steps = workflow.jobs?.[carrier.job]?.steps ?? [];

      const resolve = steps.findIndex((step) => step.name === "Resolve which repository secrets may reach this run");
      const consumer = steps.findIndex((step) => step.name === carrier.step);
      expect(resolve, `${carrier.file} secret-names step`).toBeGreaterThanOrEqual(0);
      expect(consumer, `${carrier.file} ${carrier.step}`).toBeGreaterThanOrEqual(0);
      expect(resolve, `${carrier.file}: names must resolve before the step whose env they key`).toBeLessThan(consumer);

      const env = steps[consumer]?.env ?? {};
      for (let slot = 0; slot < SECRET_SLOTS; slot++) {
        expect(env[`${SECRET_SLOT_PREFIX}${slot}`], `${carrier.file} slot ${slot}`).toBe(
          `\${{ secrets[fromJSON(steps.secret-names.outputs.names || '[]')[${slot}]] }}`,
        );
      }
      expect(env[SECRET_NAMES_VAR], carrier.file).toBe("${{ steps.secret-names.outputs.names }}");
    }
  });

  // On a pull request run the checkout is `refs/pull/N/head`, so a declaration
  // read from the working tree would let a pull request choose which of the
  // repository's secrets it is handed. `governed_paths` does not cover it: that
  // blocks the merge, and the run happens first. The declaration therefore comes
  // from the default branch, and this pins that in the generated YAML -- the
  // failure mode of losing it is silent.
  test("resolves the credential declaration from the default branch, not the checkout", () => {
    type WorkflowStep = { id?: string; run?: string; env?: Record<string, string> };
    type WorkflowDocument = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

    const directory = "dist/.github/workflows";
    const carriers = ["atoma-runner.yml", "atoma-check.yml", "atoma-deploy.yml"];

    for (const file of carriers) {
      const workflow = Bun.YAML.parse(readFileSync(join(directory, file), "utf8")) as WorkflowDocument;
      const step = Object.values(workflow.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .find((candidate) => candidate.id === "secret-names");
      expect(step, `${file} secret-names step`).toBeDefined();

      expect(step?.env?.ATOMA_DEFAULT_BRANCH, file).toBe("${{ github.event.repository.default_branch }}");
      expect(step?.run, `${file} must read the declaration from the fetched default branch`).toContain(
        'git show "FETCH_HEAD:.github/atoma/config.json"',
      );
      // Outside the workspace, so the checkout cannot have brought the file.
      expect(step?.run, `${file} must not trust a path the checkout controls`).toContain(
        "$RUNNER_TEMP/atoma-declared-secrets.json",
      );
    }
  });

  // Both of these were gaps found by trying to move this repository's own
  // pipeline onto the shipped workflows, and both fail silently rather than
  // loudly, which is why they are pinned rather than left to review.
  test("the shipped workflows cover the paths a project's pipeline needs", () => {
    type WorkflowDocument = {
      on?: { pull_request?: unknown; push?: { branches?: string[]; tags?: string[] } };
      permissions?: Record<string, string>;
      jobs?: Record<string, { if?: string; permissions?: Record<string, string>; steps?: { name?: string; env?: Record<string, string> }[] }>;
    };

    const check = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-check.yml", "utf8")) as WorkflowDocument;

    // Without this a person's pull request gets no check at all: an agent's is
    // dispatched, and `pull_request` never fires for a GITHUB_TOKEN-opened one.
    // Since this is what `workflows.ci` defaults to, the merge is then refused
    // for a required check that nothing ever ran.
    expect(check.on?.pull_request, "atoma-check must fire for a person's pull request").toBeDefined();

    // A check that cannot talk to GitHub is the only thing in the system that
    // cannot, and the failure reads as a broken command rather than no token.
    const runChecks = check.jobs?.[CHECK_JOB_NAME]?.steps?.find((s) => s.name === "Run the configured checks");
    expect(runChecks?.env?.GH_TOKEN).toBe("${{ github.token }}");

    const deploy = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-deploy.yml", "utf8")) as WorkflowDocument;

    // Cutting a release is a deployment. Read-only would push every project that
    // ships that way into keeping a personal access token instead.
    expect(deploy.jobs?.deploy?.permissions?.contents).toBe("write");

    // And the token to spend it with. `contents: write` alone is a permission
    // nothing can reach, which fails as "gh: not authenticated" -- nowhere near
    // the missing piece.
    const runDeploy = deploy.jobs?.deploy?.steps?.find((s) => s.name === "Deploy the targets this run is for");
    expect(runDeploy?.env?.GH_TOKEN).toBe("${{ github.token }}");

    // `on: merge` has to mean a person's merge too. `on:` cannot say "the default
    // branch", so the literal branches get narrowed by the job's `if:` -- and
    // losing either half is silent: too wide deploys from a branch nobody meant,
    // too narrow deploys from none.
    expect(deploy.on?.push?.branches, "atoma-deploy must listen for a merge landing").toContain("main");
    expect(deploy.jobs?.deploy?.if, "and must require it be the real default branch").toContain(
      "github.event.repository.default_branch",
    );
  });

  // The step that runs the agent lives for the whole of `atoma run`, so anything
  // in its `env:` sits in `/proc/<pid>/environ` for minutes, readable by every
  // tool server the agent starts -- and `unsetenv` cannot take it back, because
  // that file reflects what was on the stack at exec. Measured on a runner.
  //
  // So no credential may appear there. Losing this is silent: the run works, the
  // confinement is simply gone, and nothing says so.
  test("the agent step carries no credentials", () => {
    type WorkflowStep = { name?: string; env?: Record<string, string>; run?: string };
    type WorkflowDocument = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

    const workflow = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8")) as WorkflowDocument;
    const steps = workflow.jobs?.run?.steps ?? [];

    const writer = steps.findIndex((step) => step.name === "Collect this run's credentials into a file");
    const agent = steps.findIndex((step) => step.name === "Run agent");
    expect(writer, "the credentials writer step").toBeGreaterThanOrEqual(0);
    expect(writer, "credentials must be written before the agent runs").toBeLessThan(agent);

    const agentEnv = steps[agent]?.env ?? {};
    for (const [name, value] of Object.entries(agentEnv)) {
      expect(value, `${name} in the agent step must not reference a secret`).not.toContain("secrets.");
      expect(name, `${name} must not be a credential slot`).not.toStartWith(SECRET_SLOT_PREFIX);
    }
    // `github.token` counts too: it is the credential three tool servers use.
    expect(JSON.stringify(agentEnv)).not.toContain("github.token");

    // And the agent is told where to read them from instead.
    expect(steps[agent]?.run).toContain("--credentials-file");
  });

  // A pull request run checks out the pull request, so anything this job reads
  // from the workspace is the pull request's own -- which let a pull request
  // decide how the agent reviewing it behaves: which agent, which iteration
  // budget, which commands, which credentials. #337 closed that for the
  // credential declaration alone.
  //
  // The split is between the work and the machinery. Losing it is silent: runs
  // keep working, and a pull request quietly regains control of its own review.
  test("the runner reads its machinery from the default branch, not the checkout", () => {
    type WorkflowStep = { name?: string; run?: string; with?: Record<string, string> };
    type WorkflowDocument = { jobs?: Record<string, { env?: Record<string, string>; steps?: WorkflowStep[] }> };

    const workflow = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8")) as WorkflowDocument;
    const job = workflow.jobs?.run;
    const steps = job?.steps ?? [];

    // The job says where the machinery is, once, and every step inherits it.
    expect(job?.env?.ATOMA_MACHINERY_ROOT, "the job must name the machinery root").toBeTruthy();
    const root = job!.env!.ATOMA_MACHINERY_ROOT!;

    // And it is a checkout of the default branch, not of the pull request.
    const machineryCheckout = steps.find((step) => step.with?.path === root);
    expect(machineryCheckout, `a checkout into ${root}`).toBeDefined();
    expect(machineryCheckout?.with?.ref).toContain("default_branch");

    // Nothing runs a script from the workspace. A bare `.github/scripts/` would
    // be the pull request's copy.
    for (const step of steps) {
      const run = step.run ?? "";
      const bare = run.match(/(?<![\w/$}])\.github\/scripts\//g);
      expect(bare, `${step.name}: scripts must be read from the machinery root`).toBeNull();
    }

    // Nor does the agent get its definition, prompt, skills or tools from there.
    const agent = steps.find((step) => step.name === "Run agent");
    for (const flag of ["--agent-def", "--template", "--skills-dir"]) {
      const line = (agent?.run ?? "").split("\n").find((l) => l.includes(flag)) ?? "";
      expect(line, `${flag} must resolve inside the machinery root`).toContain("ATOMA_MACHINERY_ROOT");
    }
  });

  // The tool servers are machinery too, and were the last part still read from
  // the workspace: a pull request could replace the code of the very tools that
  // review it. The filesystem servers are the deliberate exception -- their `.`
  // argument IS the workspace, which is what they exist to read.
  test("the tool servers are read from the machinery, and the workspace only where intended", () => {
    const tools = readFileSync("dist/.github/atoma/tools/tools.yaml", "utf8");

    const argLines = tools.split(/\r?\n/).filter((line) => line.trim().startsWith("args:"));
    expect(argLines.length, "tools.yaml must declare some servers").toBeGreaterThan(0);

    for (const line of argLines) {
      if (line.includes("tools/scripts/")) {
        expect(line, "a server shipped here must be read from the machinery root").toContain(
          "ATOMA_MACHINERY_ROOT",
        );
      }
    }

    // And the package list and the hook chmod, which decide what gets installed
    // and whether the fail-closed guard can run at all.
    const workflow = readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8");
    for (const path of ["mcp-packages.json", "tools/scripts/hooks"]) {
      for (const line of workflow.split(/\r?\n/).filter((l) => l.includes(path))) {
        expect(line, `${path} must be read from the machinery root`).toMatch(
          /ATOMA_MACHINERY_ROOT|atoma-machinery/,
        );
      }
    }
  });

  // The two files are joined by a string and nothing else. A ruleset requires a
  // status check by `context`, which for an Actions job is the job's name -- so
  // renaming the job leaves the ruleset waiting for a check that will never
  // report again, and every pull request sits at "expected" forever. It does not
  // fail, it hangs, and an agent reads that as CI still running.
  test("the shipped ruleset requires exactly the check the shipped workflow produces", () => {
    type Ruleset = {
      rules?: { type?: string; parameters?: { required_status_checks?: { context?: string }[] } }[];
    };
    type WorkflowDocument = { jobs?: Record<string, unknown> };

    const ruleset = JSON.parse(readFileSync("dist/.github/atoma/rulesets/main.json", "utf8")) as Ruleset;
    const contexts = (ruleset.rules ?? [])
      .filter((rule) => rule.type === "required_status_checks")
      .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
      .map((entry) => entry.context)
      .filter((context): context is string => typeof context === "string");
    expect(contexts, "the shipped ruleset must require a check").not.toEqual([]);

    const workflow = Bun.YAML.parse(readFileSync("dist/.github/workflows/atoma-check.yml", "utf8")) as WorkflowDocument;
    const jobNames = Object.keys(workflow.jobs ?? {});

    expect(jobNames).toContain(CHECK_JOB_NAME);
    for (const context of contexts) {
      expect(jobNames, `ruleset requires "${context}", which no job in atoma-check.yml produces`).toContain(context);
    }
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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CHECK_SECRETS,
  DEPLOY_SECRETS,
  RUN_CREDENTIALS,
  SECRET_NAMES_VAR,
  SECRET_SLOT_PREFIX,
  TOOL_SECRETS,
  type SecretDestination,
} from "../../src/domain/declared-secrets.ts";
import { CHECK_JOB_NAME } from "../../src/workflows/atoma-check.wac.ts";

/**
 * A destination's `reserved` set is a claim about a generated workflow: these are
 * the names that job's own environment already uses, so declaring one would
 * replace a value the job depends on rather than add a credential.
 *
 * Nothing checked the claim. Each set was hand-copied from a step's `env:`, and
 * two of the three had drifted -- `DEPLOY_SECRETS` was missing the three
 * `ATOMA_DEPLOY_*` inputs that select what a run deploys, and `TOOL_SECRETS` was
 * missing `ATOMA_COPILOT_TOKEN`, so a project could name it in `tools.secrets`
 * and overwrite the credential its own run authenticates with.
 *
 * These tests read the generated YAML, so the next name added to a carrier step
 * fails here rather than becoming a shadowing hole nobody notices.
 */
type WorkflowStep = { name?: string; env?: Record<string, string> };
type WorkflowDocument = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

function carrierEnvKeys(workflow: string, job: string, stepName: string): string[] {
  const doc = Bun.YAML.parse(readFileSync(`dist/.github/workflows/${workflow}`, "utf8")) as WorkflowDocument;
  const step = doc.jobs?.[job]?.steps?.find((s) => s.name === stepName);
  // Named explicitly: a renamed step would otherwise make this test pass by
  // finding nothing to check.
  expect(step, `${workflow}: no step named "${stepName}" in job "${job}"`).toBeDefined();
  return Object.keys(step?.env ?? {});
}

/**
 * The slots are the transport for declared secrets, not names a project competes
 * with -- `renameSecretSlots()` renames each to whatever `config.json` asked for
 * before the command runs. `ATOMA_SECRET_NAMES` carries the list itself.
 */
function isSecretTransport(name: string): boolean {
  return name.startsWith(SECRET_SLOT_PREFIX) || name === SECRET_NAMES_VAR;
}

function expectAllReserved(destination: SecretDestination, keys: string[]): void {
  const unreserved = keys.filter((key) => !isSecretTransport(key) && !destination.reserved.has(key));
  expect(unreserved, `${destination.field} does not reserve these, so a project could shadow them`).toEqual([]);
}

describe("reserved names match the workflows they describe", () => {
  test("the agent's step", () => {
    expectAllReserved(TOOL_SECRETS, carrierEnvKeys("atoma-runner.yml", "run", "Run agent"));
  });

  test("the checks step", () => {
    expectAllReserved(CHECK_SECRETS, carrierEnvKeys("atoma-check.yml", CHECK_JOB_NAME, "Run the configured checks"));
  });

  test("the deploy step", () => {
    expectAllReserved(DEPLOY_SECRETS, carrierEnvKeys("atoma-deploy.yml", "deploy", "Deploy the targets this run is for"));
  });

  // The other half of the same contract, and the half that actually broke. These
  // are written into the credentials file first and the declared names after,
  // into one object -- so a declared name that collides does not add a
  // credential, it replaces the run's own.
  test("every credential the run supplies is reserved against tools.secrets", () => {
    const unreserved = RUN_CREDENTIALS.filter((name) => !TOOL_SECRETS.reserved.has(name));
    expect(unreserved).toEqual([]);
  });
});

/**
 * The step that supplies the run's credentials supplies all of them.
 *
 * `RUN_CREDENTIALS` decides what "the run's own credentials" means: `collect()` iterates
 * it to build the file atoma reads. The step's `env:` is where those values come from, and
 * the two were hand-kept mirrors — six lines against six entries, in sync with nothing
 * holding them there.
 *
 * Both directions are silent. A name in the list and not the step is looked up, found
 * empty, dropped, and the run fails at its first inference with a provider error naming
 * nothing near the omission. A name in the step and not the list is a secret exported into
 * a step for no reader.
 *
 * Written after exactly that: generating the step from the list dropped `GH_TOKEN`,
 * because its value is the run's own token rather than a repository secret, and nothing
 * failed until the next run would have found every GitHub tool server unauthenticated.
 */
describe("the credentials step and RUN_CREDENTIALS", () => {
  const CREDENTIALS_STEP = "Collect this run's credentials into a file";

  function stepEnv(): Record<string, string> {
    const doc = Bun.YAML.parse(
      readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8"),
    ) as { jobs?: Record<string, { steps?: { name?: string; env?: Record<string, string> }[] }> };
    const step = doc.jobs?.run?.steps?.find((candidate) => candidate.name === CREDENTIALS_STEP);
    expect(step, `atoma-runner.yml has no step named "${CREDENTIALS_STEP}"`).toBeDefined();
    return step?.env ?? {};
  }

  test("every credential the run declares is supplied to the step", () => {
    const env = stepEnv();
    for (const name of RUN_CREDENTIALS) {
      expect(
        Object.keys(env),
        `${name} is in RUN_CREDENTIALS, so nothing supplies it and collect() drops it`,
      ).toContain(name);
      expect(env[name], `${name} is supplied as an empty value`).toBeTruthy();
    }
  });

  test("the step supplies nothing that is not a declared credential or a secret slot", () => {
    const declared = new Set<string>(RUN_CREDENTIALS);
    for (const name of Object.keys(stepEnv())) {
      if (name.startsWith(SECRET_SLOT_PREFIX) || name === SECRET_NAMES_VAR) continue;
      expect(declared.has(name), `${name} is exported into the step and read by nobody`).toBe(
        true,
      );
    }
  });
});

#!/usr/bin/env bun
/**
 * read_secret_names.ts — publishes, as a step output, which repository secrets
 * this project's configuration lets one destination reach.
 *
 * The output feeds a computed-key lookup in a later step's `env:`
 * (`secrets[fromJSON(steps.<id>.outputs.names)[i]]`), which is what lets a
 * project add a credential without editing generated workflow YAML. See
 * domain/declared-secrets.ts for why it is shaped that way and what was measured
 * before relying on it.
 *
 * ## Why this reads a file it is handed, and not the checkout
 *
 * Every other script here reads `.github/atoma/config.json` through
 * `lib/config.ts`, which resolves it against the working tree. This one must
 * not. On a pull request run the working tree is the pull request's own head --
 * `atoma-runner.yml` checks out `refs/pull/N/head` -- so reading the declaration
 * from there would let a pull request decide which of the repository's secrets
 * are handed to the run reviewing it. The governance gate does not help: it
 * blocks the merge, and the run happens before the merge.
 *
 * The caller materialises the DEFAULT BRANCH's config.json and passes its path.
 * The distinction is deliberate and worth keeping straight: what a run *does*
 * comes from the branch under test, and what a run *may reach* comes from the
 * branch a person already approved.
 *
 * ## Failure behaviour
 *
 * No `--config`, or a file that cannot be read, declares nothing and says so.
 * Both fail closed: the run continues with no credentials rather than stopping,
 * and never falls back to the working tree, which is the thing a pull request
 * controls.
 *
 * `--config` is deliberately NOT required, though the workflow always passes it.
 * Requiring it made a deployment break itself: a deploy pull request is reviewed
 * by a run whose workflow YAML comes from the base branch and whose scripts come
 * from the pull request, so the release that first passed `--config` met the
 * previous release's workflow, which did not, and exited 2. A missing argument
 * is a degradation worth logging, not one worth failing a run over — and
 * `generated-workflows.test.ts` pins the workflow side, so it cannot be dropped
 * there without CI saying so.
 *
 * An unusable declaration does fail the run. Delivering the names that happen to
 * be valid turns a typo into a failure much later, somewhere that points nowhere
 * near the cause.
 *
 * Usage:
 *   read_secret_names.ts --destination tools|checks|deploy [--config <path>]
 */
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  isSecretDestinationName,
  resolveDeclaredSecrets,
  SECRET_DESTINATIONS,
  type SecretDestinationName,
} from "../domain/declared-secrets.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface ReadSecretNamesArgs {
  /** Which of the configuration's credential lists to publish. */
  destination: string;
  /** The trusted config.json to read it from — NOT the working tree's. */
  config: string;
}

export const ref = defineScript<ReadSecretNamesArgs>(import.meta.url);

/** The declaration for `destination`, or undefined when the file cannot be used. */
export function declarationIn(configText: string, destination: SecretDestinationName): unknown {
  const config = JSON.parse(configText) as {
    tools?: { secrets?: unknown };
    checks?: { secrets?: unknown };
    deploy?: { secrets?: unknown };
  };
  return { tools: config.tools, checks: config.checks, deploy: config.deploy }[destination]?.secrets;
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { destination: { type: "string" }, config: { type: "string" } },
  });
  const destination = values.destination ?? "";
  if (!isSecretDestinationName(destination)) {
    console.error(`::error::read_secret_names: unknown destination '${destination}'.`);
    process.exit(2);
  }
  let declared: unknown;
  if (!values.config) {
    console.error(
      "::warning::read_secret_names: no --config given, so no credentials are declared for this run. The workflow should pass the default branch's config.json.",
    );
  } else {
    try {
      declared = declarationIn(readFileSync(values.config, "utf8"), destination);
    } catch (error) {
      console.error(`No credential declaration could be read (${(error as Error).message}); declaring none.`);
    }
  }

  const { names, problems } = resolveDeclaredSecrets(declared, SECRET_DESTINATIONS[destination]);

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::.github/atoma/config.json: ${problem}`);
    }
    process.exit(1);
  }

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `names=${JSON.stringify(names)}\n`);
  }

  // Names only. The values are secrets; that these particular ones travel is
  // already public in config.json, and saying so makes a missing repository
  // secret diagnosable from the log.
  console.error(
    names.length > 0
      ? `Secrets declared for ${destination}: ${names.join(", ")}`
      : `No secrets declared for ${destination}.`,
  );
}

if (import.meta.main) main();

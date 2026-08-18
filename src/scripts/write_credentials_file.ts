#!/usr/bin/env bun
/**
 * write_credentials_file.ts — collect this run's credentials into a JSON file for
 * `atoma run --credentials-file`.
 *
 * ## Why a file, and why this step exists at all
 *
 * A value in an environment block cannot be taken back. `/proc/<pid>/environ`
 * reflects what was placed on the stack at `execve`, and `unsetenv` does not
 * rewrite it — so anything that was ever in a process's environment stays
 * readable there, by any process of the same user, for that process's lifetime.
 *
 * The "Run agent" step's bash lives for the whole of `atoma run`. Giving it the
 * credentials therefore leaves them readable from `/proc` for minutes, to every
 * tool server the agent starts. Writing them here instead means only THIS step's
 * bash ever holds them, and it exits before the agent begins.
 *
 * atoma reads the file and deletes it before starting any tool server, so the
 * file and the servers never coexist. From then on the values are in atoma's
 * heap, which is out of reach: it makes itself non-dumpable.
 *
 * ## What goes in
 *
 * The credentials atoma itself needs (the provider key), the GitHub token the
 * `github`/`search`/`atoma` servers authenticate with, and whatever this project
 * declared in `tools.secrets`. Nothing else — this is not a dump of the
 * environment.
 *
 * Empty values are omitted rather than written as `""`. An unset repository
 * secret arrives as an empty string, and a present-but-empty key would tell
 * atoma's provider detection that a provider is configured when it is not.
 *
 * ## Where
 *
 * `$RUNNER_TEMP`, which is outside the workspace, so the checkout cannot have
 * placed a file there and nothing commits it by accident. tmpfs (`/dev/shm`)
 * would additionally keep the value off persistent storage, which is what
 * Kubernetes does for the same reason; that is worth measuring on a runner before
 * relying on it.
 *
 * Usage:
 *   write_credentials_file.ts --out "$RUNNER_TEMP/atoma-credentials.json"
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { SECRET_NAMES_VAR, SECRET_SLOT_PREFIX, SECRET_SLOTS } from "../domain/declared-secrets.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface WriteCredentialsFileArgs {
  /** Path to write. Must be outside the workspace. */
  out: string;
}

export const ref = defineScript<WriteCredentialsFileArgs>(import.meta.url);

/**
 * Credentials the run needs regardless of what the project declared.
 *
 * The provider keys because atoma calls the model with one, and the GitHub token
 * because the tool servers that reach GitHub authenticate with it. Both were
 * previously in the agent step's own environment; the point of this script is
 * that they no longer are.
 *
 * `ATOMA_COPILOT_TOKEN` is included so a project using GitHub Copilot as its
 * provider works through this path too — atoma reads that name, and leaving it
 * out would silently confine a run to the providers listed beside it.
 */
const ALWAYS: readonly string[] = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ATOMA_COPILOT_TOKEN", "GH_TOKEN"];

/** The credentials to write, from the environment this step was given. */
export function collect(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const name of ALWAYS) {
    const value = env[name];
    if (value) out[name] = value;
  }

  // Declared tool credentials arrive in numbered slots, because a step's `env:`
  // is a static map and cannot be keyed by a name the workflow does not know.
  let declared: string[] = [];
  try {
    declared = JSON.parse(env[SECRET_NAMES_VAR] || "[]") as string[];
  } catch {
    console.error(`::warning::${SECRET_NAMES_VAR} was not valid JSON; no declared credentials will be written.`);
  }

  declared.slice(0, SECRET_SLOTS).forEach((name, slot) => {
    const value = env[`${SECRET_SLOT_PREFIX}${slot}`];
    if (value) out[name] = value;
    else {
      console.error(
        `::warning::config.json declares ${name}, but this repository has no secret by that name. Whatever needs it will fail.`,
      );
    }
  });

  return out;
}

function main(): void {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { out: { type: "string" } } });
  if (!values.out) {
    console.error("usage: write_credentials_file.ts --out FILE");
    process.exit(2);
  }

  const credentials = collect(process.env);
  // Mode 0600 is a gesture rather than a control: every process here runs as the
  // same user, so it stops nothing that matters. It costs nothing and states the
  // intent.
  writeFileSync(values.out, JSON.stringify(credentials), { mode: 0o600 });

  // Names only, never values. Which credentials a run carries is already public
  // in config.json, and saying so is what makes a missing one diagnosable.
  console.error(
    `Wrote ${Object.keys(credentials).length} credential(s) for this run: ${Object.keys(credentials).join(", ")}`,
  );
}

if (import.meta.main) main();

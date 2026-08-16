/**
 * secret-slots.ts — the one way a generated workflow carries a credential it
 * cannot name.
 *
 * A step's `env:` is a static YAML map, so a workflow generated upstream can
 * only reference secrets whose names were known when it was generated. Reaching
 * one through a COMPUTED key — `secrets[fromJSON(<names>)[i]]` — moves that
 * decision to run time, and config.json becomes where a project says which of
 * its secrets a workflow may see. See `domain/declared-secrets.ts` for what was
 * measured before relying on this.
 *
 * Three workflows need the identical arrangement (atoma-runner, atoma-check,
 * atoma-deploy) and getting it subtly wrong in one is invisible: the credential
 * simply never arrives, and only whatever needed it fails. So the slot `env:`
 * and the bash that renames the slots are built here, from the same constants,
 * rather than written out three times.
 */
import {
  SECRET_NAMES_VAR,
  SECRET_SLOT_PREFIX,
  SECRET_SLOTS,
  type SecretDestinationName,
} from "../../domain/declared-secrets.ts";
import { scriptCommandWithArgs } from "./script-call.ts";
import { ref as readSecretNamesRef } from "../../scripts/read_secret_names.ts";
import { TypedOutputsStep } from "./base.ts";

/** Step id the slot expressions key off. One per workflow, so a constant is enough. */
export const SECRET_NAMES_STEP_ID = "secret-names";

/**
 * The step that publishes which secrets this destination may reach.
 *
 * Place it after checkout — it reads config.json — and before the step whose
 * `env:` uses the slots. Step-level `env:` is evaluated when that step runs, not
 * when the job starts, which is what lets a step output key a secret and is why
 * no separate job is needed.
 */
export function secretNamesStep(destination: SecretDestinationName): TypedOutputsStep<"names"> {
  return new TypedOutputsStep(
    {
      name: "Resolve which repository secrets may reach this run",
      id: SECRET_NAMES_STEP_ID,
      shell: "bash",
      run: `${scriptCommandWithArgs(readSecretNamesRef, { destination })}\n`,
    },
    ["names"] as const,
  );
}

/**
 * `env:` entries carrying the declared credentials into a step.
 *
 * `|| '[]'` keeps an empty output — a skipped or failed resolve step — from
 * making `fromJSON` throw, which would fail every run in a repository that
 * declares no secrets at all. That is the common case, so it must not be the
 * fragile one.
 */
export function secretSlotEnv(): Record<string, string> {
  const names = `steps.${SECRET_NAMES_STEP_ID}.outputs.names`;
  return {
    ...Object.fromEntries(
      Array.from({ length: SECRET_SLOTS }, (_, slot) => [
        `${SECRET_SLOT_PREFIX}${slot}`,
        `\${{ secrets[fromJSON(${names} || '[]')[${slot}]] }}`,
      ]),
    ),
    [SECRET_NAMES_VAR]: `\${{ ${names} }}`,
  };
}

/**
 * Bash that puts the declared name back on each slot, for the top of a step
 * whose `env:` includes `secretSlotEnv()`.
 *
 * A declared name with an empty slot means config.json asks for a secret the
 * repository does not have. That is a warning and not a failure: only whatever
 * needed that credential will fail, with the reason already in the log, and
 * failing the whole run would take the rest of the work with it.
 */
export function renameSecretSlots(): string {
  return `# Credentials arrive in numbered slots because this file is generated and cannot
# know what a project called its Slack token; config.json does, and the resolve
# step above published that list. Put the declared name back on each slot before
# anything that needs one runs.
ATOMA_DECLARED_SECRETS="\${${SECRET_NAMES_VAR}:-[]}"
ATOMA_DECLARED_COUNT=$(echo "$ATOMA_DECLARED_SECRETS" | jq -r 'length')
slot=0
while [ "$slot" -lt "$ATOMA_DECLARED_COUNT" ]; do
  secret_name=$(echo "$ATOMA_DECLARED_SECRETS" | jq -r ".[\${slot}]")
  eval "secret_value=\\\${${SECRET_SLOT_PREFIX}\${slot}:-}"
  if [ -n "$secret_value" ]; then
    export "\${secret_name}=\${secret_value}"
    echo "Secret \${secret_name} is available to this run."
  else
    echo "::warning::config.json declares secret \${secret_name}, but this repository has no secret by that name. Whatever needs it will fail."
  fi
  slot=$((slot + 1))
done
`;
}

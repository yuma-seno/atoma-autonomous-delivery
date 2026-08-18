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
 * Place it after checkout — it needs a git remote — and before the step whose
 * `env:` uses the slots. Step-level `env:` is evaluated when that step runs, not
 * when the job starts, which is what lets a step output key a secret and is why
 * no separate job is needed.
 *
 * It reads the declaration from the DEFAULT BRANCH, not from the checkout. On a
 * pull request run the checkout is `refs/pull/N/head`, so reading it there would
 * let a pull request decide which of the repository's secrets are handed to the
 * run that reviews it — and `governed_paths` does not cover that, because it
 * blocks the merge and this happens before the merge.
 *
 * Only the declaration is treated this way. The commands a run executes still
 * come from the branch under test, which is the point of testing it. What
 * changes hands is a privilege, and a privilege comes from the branch a person
 * already approved.
 *
 * `$RUNNER_TEMP` rather than the workspace, so the file cannot be one the
 * checkout brought with it.
 *
 * ## Why the fetch writes its own ref instead of using FETCH_HEAD
 *
 * This used to be `git fetch ... || true` followed by
 * `git show "FETCH_HEAD:.github/atoma/config.json"`. `actions/checkout` has
 * already written a FETCH_HEAD for the pull request's own ref by the time this
 * step runs, so a failed fetch did not reach the fall-back: the `git show`
 * succeeded against the pull request's own file, the run took its declaration
 * from the branch under review, and nothing warned because nothing had failed.
 *
 * The `|| true` was there so a fetch failure would not fail the run. It degraded
 * open instead of safely, on the one guarantee this step provides. Fetching into
 * a ref this step owns removes the thing there was to fall back to.
 *
 * The rationale lives here rather than in the emitted shell: an adopter reading
 * the generated workflow needs to know what the line does, not which bug it
 * replaced.
 */
export function secretNamesStep(destination: SecretDestinationName): TypedOutputsStep<"names"> {
  const trustedConfig = "$RUNNER_TEMP/atoma-declared-secrets.json";
  return new TypedOutputsStep(
    {
      name: "Resolve which repository secrets may reach this run",
      id: SECRET_NAMES_STEP_ID,
      shell: "bash",
      env: { ATOMA_DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}" },
      run: `DEFAULT_BRANCH="\${ATOMA_DEFAULT_BRANCH:-main}"
TRUSTED_CONFIG="${trustedConfig}"

# Fetched into a ref this line owns, and read back from that same ref, so a
# failed fetch has nothing to fall back to. Shallow: one commit of one branch is
# all this needs. \`+\` so a re-run overwrites rather than refusing.
if git fetch --quiet --depth=1 origin "+\$DEFAULT_BRANCH:refs/atoma/trusted-config" 2>/dev/null \\
  && git show "refs/atoma/trusted-config:.github/atoma/config.json" > "$TRUSTED_CONFIG" 2>/dev/null; then
  echo "Read the credential declaration from \${DEFAULT_BRANCH}."
else
  # Either the branch has no config.json or the fetch failed, and this cannot
  # tell which. It does not need to: both answers are "declare nothing", which is
  # the safe one. Naming both is the honest message -- asserting the first would
  # be asserting something this could not determine.
  echo '{}' > "$TRUSTED_CONFIG"
  echo "::warning::Could not read .github/atoma/config.json from \${DEFAULT_BRANCH} (absent, or the fetch failed); this run reaches no declared credentials."
fi

${scriptCommandWithArgs(readSecretNamesRef, { destination, config: trustedConfig })}
`,
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

/**
 * declared-secrets.ts — which repository secrets each workflow may reach, and
 * why the list has to be declared rather than discovered.
 *
 * Something a project runs — a tool server, a check, a deployment — often needs a
 * credential, and the credential belongs in repository secrets. Getting it from
 * there into the process is the awkward part: a step's `env:` is a static YAML
 * map, so every secret a workflow can reach is named at the moment that file is
 * generated — which is upstream, and which no adopter should have to edit.
 *
 * The way out is to reach the secret through a COMPUTED key,
 * `secrets[fromJSON(...)[i]]`, filling a fixed number of anonymous slots whose
 * meaning is decided at run time by whatever this module returns. The workflow
 * stops naming credentials; config.json names them instead.
 *
 * Two things were measured before building on this, because either would have
 * sunk it. GitHub's malicious-workflow detector blocks `toJSON(secrets)` — a run
 * containing it never starts, it only queues for approval — but it allows a
 * computed key. And a computed key still gets the ordinary masking: the value
 * comes out of the log as `***`, exactly as `${{ secrets.NAME }}` would, which is
 * what makes this preferable to packing several credentials into one JSON secret
 * (which would also mean keeping the whole set outside GitHub, since a secret
 * cannot be read back to add one key to it).
 *
 * ## One mechanism, three destinations
 *
 * `tools.secrets`, `checks.secrets` and `deploy.secrets` are separate lists
 * because they arrive in separate workflows, in separate jobs, in separate
 * processes. The nesting is the boundary and not a filing convention: only
 * `tools.secrets` enters the agent's own environment, so a prompt injection
 * carried in an issue body reaches those and no deployment credential. It could
 * still propose a command that reads one — but that is a change to config.json,
 * which is governed, so a person sees it first.
 *
 * Collapsing these into one list would put every credential in every
 * destination while still looking like a boundary, which is worse than having
 * no boundary at all.
 *
 * The declaration lives in config.json rather than in a repository variable
 * because it is the most security-relevant setting this project has. In
 * config.json it is versioned, it shows up in a diff, and it passes the
 * governance gate that already covers `.github/**`. In repository settings it
 * would be invisible to everyone reviewing the repository — which is precisely
 * the audience for "what credentials can this reach".
 */

/**
 * How many credentials one workflow can carry.
 *
 * Fixed because each slot is a literal line of generated YAML; the cap can only
 * move in a release. Ten is well past what any one destination plausibly needs,
 * and an eleventh is a loud configuration error rather than a silently dropped
 * secret — see `resolveDeclaredSecrets`.
 */
export const SECRET_SLOTS = 10;

/** Environment variable each slot arrives under, before it is renamed. */
export const SECRET_SLOT_PREFIX = "ATOMA_SECRET_";

/** Carries the resolved names into the job so the slots can be renamed. */
export const SECRET_NAMES_VAR = "ATOMA_SECRET_NAMES";

/**
 * Shape GitHub accepts for a secret name, minus lowercase.
 *
 * GitHub itself allows lowercase and normalises it, but a name that arrives as an
 * environment variable should look like one, and accepting both spellings would
 * mean `slack_token` and `SLACK_TOKEN` are the same secret and two different
 * declarations.
 */
const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** A place credentials can be sent, and what it already calls its own variables. */
export interface SecretDestination {
  /** Dotted path in config.json, used in every message this produces. */
  readonly field: string;
  /**
   * Names the destination's own environment already uses.
   *
   * Declaring one of these would not add a credential, it would replace one the
   * job depends on — a `GH_TOKEN` from configuration silently standing in for the
   * workflow's own token is the kind of thing that works in testing and is a
   * security incident in production. Rejected at configuration time, where the
   * message can say so, rather than at run time where the symptom is a confusing
   * failure.
   */
  readonly reserved: ReadonlySet<string>;
}

/**
 * Credentials every run is handed, whatever the project declared.
 *
 * The provider keys because atoma calls the model with one, and the GitHub token
 * because the tool servers that reach GitHub authenticate with it.
 *
 * This list lives here, in the module that decides what a project may declare,
 * because the two facts are the same fact: a name the run supplies is a name a
 * project must not be able to supply instead. `write_credentials_file.ts` writes
 * these first and the declared names after, into one object, so a later key wins
 * — declaring one of these does not add a credential, it silently replaces the
 * run's own.
 *
 * It used to be a second hand-written copy in that script, and the copy had
 * already drifted: `ATOMA_COPILOT_TOKEN` was in it and missing from `reserved`
 * below, so a project could name it in `tools.secrets` and overwrite the very
 * credential its Copilot-backed run authenticates with. The other three were
 * reserved. Only the newest name was missed, which is what a hand-kept mirror
 * does — it is right until the day something is added to one side.
 */
export const RUN_CREDENTIALS: readonly string[] = [
  "OPENAI_API_KEY",
  // One provider, one credential, since atoma v0.1.13. `OPENAI_API_KEY` used to
  // authenticate anything speaking OpenAI's dialect, including OpenRouter, so the
  // name said nothing about where the key was going to be sent. These two are the
  // routers' own names, and there is no fallback to the old one: a run holding both
  // is an error naming both rather than a silent precedence.
  "OPENROUTER_API_KEY",
  "ORCAROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ATOMA_COPILOT_TOKEN",
  "GH_TOKEN",
];

/**
 * The agent's own process: `RUN_CREDENTIALS`, plus the run context in the "Run
 * agent" step's `env:` (`atoma-runner.wac.ts`) and the names atoma derives for
 * itself from the credentials file.
 *
 * The credentials are no longer in that step's environment — they are written to
 * a file by an earlier step that exits before the agent starts — so this is a
 * union of two places rather than a mirror of one. Reserving them is not about
 * where they sit; it is about the agent's process ending up with one meaning per
 * name.
 */
export const TOOL_SECRETS: SecretDestination = {
  field: "tools.secrets",
  reserved: new Set([
    ...RUN_CREDENTIALS,
    "AGENT",
    "ATOMA_OPS_LOG",
    "ATOMA_PROVIDER",
    "ATOMA_RUN_TYPE",
    "GITHUB_RUN_ID",
    "ISSUE_NOTIFY",
    "ISSUE_NUMBER",
    // One per provider, all of them the same shape since atoma v0.1.13: a
    // declared secret that shadowed one would move that provider's endpoint, which
    // is a way to send a credential somewhere else.
    "OPENAI_BASE_URL",
    "OPENROUTER_BASE_URL",
    "ORCAROUTER_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "COPILOT_BASE_URL",
    // The repository-variable forms the step is actually given. The run script
    // promotes each to the unsuffixed name above once it has checked it is not
    // empty, so shadowing either would decide the provider or its host before
    // that check ever runs.
    "ATOMA_PROVIDER_IN",
    "OPENAI_BASE_URL_IN",
  ]),
};

/**
 * `GITHUB_PERSONAL_ACCESS_TOKEN` is deliberately NOT reserved, having been until
 * now. The runner stopped setting it — "gone rather than moved: nothing in either
 * repository reads it" — so reserving it refused a name for a variable that no
 * longer exists. It is also the name the official GitHub MCP server reads, which
 * makes it one of the likelier things a project would legitimately want to
 * declare, and refusing it bought nothing.
 */

/** Mirrors the `env:` of the command step in `atoma-check.wac.ts`. */
export const CHECK_SECRETS: SecretDestination = {
  field: "checks.secrets",
  reserved: new Set(["GH_TOKEN"]),
};

/**
 * The deploy job's own variables, from two places.
 *
 * `atoma-deploy.wac.ts` puts `GH_TOKEN` and the three `ATOMA_DEPLOY_*` inputs in
 * the command step's `env:`, and `run_deploy.ts` sets `ATOMA_DEPLOY_TARGET` per
 * command as it runs them. Both belong here: the declared slots are `export`ed
 * into that same shell before the command runs, so either could be replaced.
 *
 * The three inputs matter more than they look. `ATOMA_DEPLOY_REF` and
 * `ATOMA_DEPLOY_TRIGGER` are what select which targets a run deploys — declaring
 * one would not leak anything, it would quietly redirect the deployment.
 */
export const DEPLOY_SECRETS: SecretDestination = {
  field: "deploy.secrets",
  reserved: new Set([
    "ATOMA_DEPLOY_REF",
    "ATOMA_DEPLOY_TARGET",
    "ATOMA_DEPLOY_TARGET_INPUT",
    "ATOMA_DEPLOY_TRIGGER",
    "GH_TOKEN",
  ]),
};

/** Every destination, for the callers that need to name one from a string. */
export const SECRET_DESTINATIONS = {
  tools: TOOL_SECRETS,
  checks: CHECK_SECRETS,
  deploy: DEPLOY_SECRETS,
} as const;

export type SecretDestinationName = keyof typeof SECRET_DESTINATIONS;

/** True when `value` names one of the destinations above. */
export function isSecretDestinationName(value: string): value is SecretDestinationName {
  return Object.hasOwn(SECRET_DESTINATIONS, value);
}

export interface SecretsResolution {
  /** Declared names, in slot order. Empty when nothing is configured. */
  readonly names: readonly string[];
  /** Every problem found, so one run reports all of them instead of the first. */
  readonly problems: readonly string[];
}

/**
 * Validate one destination's declaration and put it in slot order.
 *
 * Absent and `[]` both mean "no credentials here", which is the normal case and
 * not a problem. Anything else that cannot be honoured exactly is a problem:
 * this returns names only when every one of them is usable, because a partially
 * applied credential list gives the process a confusing runtime failure instead
 * of a configuration error anyone can act on.
 */
export function resolveDeclaredSecrets(raw: unknown, destination: SecretDestination): SecretsResolution {
  const { field, reserved } = destination;
  if (raw === undefined || raw === null) return { names: [], problems: [] };

  if (!Array.isArray(raw)) {
    return { names: [], problems: [`\`${field}\` must be an array of secret names.`] };
  }

  const problems: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== "string") {
      problems.push(`\`${field}\` entries must be strings; found ${JSON.stringify(entry)}.`);
      continue;
    }
    const name = entry.trim();
    if (!NAME_PATTERN.test(name)) {
      problems.push(
        `\`${field}\`: '${name}' is not a usable secret name. Expected uppercase letters, digits and underscores, starting with a letter — e.g. 'SLACK_TOKEN'.`,
      );
      continue;
    }
    if (reserved.has(name)) {
      problems.push(
        `\`${field}\`: '${name}' is already part of the environment this workflow provides, so declaring it would replace that value rather than add a credential. Give the secret another name.`,
      );
      continue;
    }
    if (name.startsWith(SECRET_SLOT_PREFIX)) {
      problems.push(
        `\`${field}\`: '${name}' collides with the slots this mechanism uses internally. Give the secret another name.`,
      );
      continue;
    }
    if (seen.has(name)) {
      problems.push(`\`${field}\`: '${name}' is declared more than once.`);
      continue;
    }
    seen.add(name);
    names.push(name);
  }

  if (names.length > SECRET_SLOTS) {
    problems.push(
      `\`${field}\` declares ${names.length} secrets but a run carries at most ${SECRET_SLOTS}. Raising the cap needs a new release, since each slot is a line of generated workflow YAML.`,
    );
  }

  return problems.length > 0 ? { names: [], problems } : { names, problems };
}

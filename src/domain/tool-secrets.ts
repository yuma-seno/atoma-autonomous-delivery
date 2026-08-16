/**
 * tool-secrets.ts — which repository secrets a run is allowed to hand to the
 * agent, and why the list has to be declared rather than discovered.
 *
 * A tool server that talks to something outside GitHub needs a credential, and
 * the credential belongs in repository secrets. Getting it from there into the
 * agent's process is the awkward part: a step's `env:` is a static YAML map, so
 * every secret a run can reach is named in `atoma-runner.yml` at the moment that
 * file is generated — which is upstream, and which no adopter should have to
 * edit to add a tool.
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
 * what makes this preferable to packing several credentials into one JSON secret.
 *
 * The declaration lives in config.json rather than in a repository variable
 * because it is the most security-relevant setting this project has. In
 * config.json it is versioned, it shows up in a diff, and it passes the
 * governance gate that already covers `.github/atoma/**`. In repository settings
 * it would be invisible to everyone reviewing the repository — which is precisely
 * the audience for "what credentials does the agent get to see".
 */

/**
 * How many credentials a run can carry.
 *
 * Fixed because each slot is a literal line of generated YAML; the cap can only
 * move in a release. Ten is well past what a tool server set plausibly needs, and
 * an eleventh is a loud configuration error rather than a silently dropped
 * secret — see `resolveToolSecrets`.
 */
export const TOOL_SECRET_SLOTS = 10;

/** Environment variable each slot arrives under, before it is renamed. */
export const TOOL_SECRET_SLOT_PREFIX = "ATOMA_TOOL_SECRET_";

/** Carries the resolved names into the run so the slots can be renamed. */
export const TOOL_SECRET_NAMES_VAR = "ATOMA_TOOL_SECRET_NAMES";

/**
 * Shape GitHub accepts for a secret name, minus lowercase.
 *
 * GitHub itself allows lowercase and normalises it, but a name that reaches the
 * agent as an environment variable should look like one, and accepting both
 * spellings would mean `slack_token` and `SLACK_TOKEN` are the same secret and
 * two different declarations.
 */
const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Names the run already uses for itself.
 *
 * Mirrors the `env:` of the "Run agent" step in `atoma-runner.wac.ts`. Declaring
 * one of these would not add a credential, it would replace one the run depends
 * on — a `GH_TOKEN` from configuration silently standing in for the workflow's
 * own token is the kind of thing that works in testing and is a security
 * incident in production. Rejected at configuration time, where the message can
 * say so, rather than at run time where the symptom is a confusing failure.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "AGENT",
  "ANTHROPIC_API_KEY",
  "ATOMA_OPS_LOG",
  "ATOMA_PROVIDER",
  "ATOMA_RUN_TYPE",
  "GH_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GITHUB_RUN_ID",
  "ISSUE_NOTIFY",
  "ISSUE_NUMBER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
]);

export interface ToolSecretsResolution {
  /** Declared names, in slot order. Empty when nothing is configured. */
  readonly names: readonly string[];
  /** Every problem found, so one run reports all of them instead of the first. */
  readonly problems: readonly string[];
}

/**
 * Validate the `tool_secrets` declaration and put it in slot order.
 *
 * Absent and `[]` both mean "no tool credentials", which is the normal case and
 * not a problem. Anything else that cannot be honoured exactly is a problem:
 * this returns names only when every one of them is usable, because a partially
 * applied credential list gives a tool server a confusing runtime failure
 * instead of a configuration error anyone can act on.
 */
export function resolveToolSecrets(raw: unknown): ToolSecretsResolution {
  if (raw === undefined || raw === null) return { names: [], problems: [] };

  if (!Array.isArray(raw)) {
    return { names: [], problems: ["`tool_secrets` must be an array of secret names."] };
  }

  const problems: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== "string") {
      problems.push(`\`tool_secrets\` entries must be strings; found ${JSON.stringify(entry)}.`);
      continue;
    }
    const name = entry.trim();
    if (!NAME_PATTERN.test(name)) {
      problems.push(
        `'${name}' is not a usable secret name. Expected uppercase letters, digits and underscores, starting with a letter — e.g. 'SLACK_TOKEN'.`,
      );
      continue;
    }
    if (RESERVED_NAMES.has(name)) {
      problems.push(
        `'${name}' is already part of the environment a run gives the agent, so declaring it would replace that value rather than add a credential. Give the secret another name.`,
      );
      continue;
    }
    if (name.startsWith(TOOL_SECRET_SLOT_PREFIX)) {
      problems.push(`'${name}' collides with the slots this mechanism uses internally. Give the secret another name.`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`'${name}' is declared more than once.`);
      continue;
    }
    seen.add(name);
    names.push(name);
  }

  if (names.length > TOOL_SECRET_SLOTS) {
    problems.push(
      `\`tool_secrets\` declares ${names.length} secrets but a run carries at most ${TOOL_SECRET_SLOTS}. Raising the cap needs a new release, since each slot is a line of generated workflow YAML.`,
    );
  }

  return problems.length > 0 ? { names: [], problems } : { names, problems };
}

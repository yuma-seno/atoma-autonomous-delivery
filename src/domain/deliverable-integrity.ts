/**
 * deliverable-integrity.ts — whether the `.github/atoma/` a pull request would
 * merge is internally consistent, decided from its content and nothing else.
 *
 * ## What this is for
 *
 * A name in configuration that resolves to nothing is the one class of defect
 * this project keeps producing and cannot see. `mcp_servers: [filesystem]` with
 * no `filesystem` in tools.yaml aborts the whole run before a single server
 * starts; `agents.enginer` sets an iteration budget for nobody; an
 * `auto_triggers` entry that fails validation resolves the WHOLE list to empty,
 * so every trigger stops firing. Each of those is silent at merge time and
 * surfaces on whoever triggers the next run.
 *
 * ## What it deliberately does not do
 *
 * No new validator is written here. Every rule below is either a reference that
 * either resolves or does not, or a call to a resolver that already exists and
 * already runs — `resolveAutoTriggers`, `resolveMergeGates`,
 * `resolveDeployTargets`, `resolveDeclaredSecrets`. All four are pure functions of
 * a config value, and all four currently run too late to matter: at merge time, at
 * deploy time, when a credential is handed out. Running them at pull-request time
 * adds no opinion, it moves an existing one earlier.
 *
 * Anything that needs a run to find out is out of scope and stays out. Whether a
 * `checks.commands` entry passes, whether a deploy target's shell works, whether a
 * model answers — none of that is knowable from the files, and pretending
 * otherwise would make this a second, worse CI.
 *
 * ## Where the agent definitions and tools.yaml are checked
 *
 * Not here. `atoma validate --agent-def X.md --tools-file tools.yaml` already
 * checks the parse, `mcp_servers` against the tools file, `knows_about` targets,
 * `callable_by` values, `extra_body` reserved keys and the hook paths the tools
 * file names — using the same code the run itself uses. `validate_deliverable.ts`
 * calls it once per agent definition rather than reimplementing any of that in
 * TypeScript, which would be the same facts in two languages.
 *
 * So this module owns exactly one format: config.json, which is delivery's own and
 * which the core has never heard of.
 */
import { resolveAutoTriggers } from "./auto-triggers.ts";
import { resolveDeclaredSecrets, SECRET_DESTINATIONS } from "./declared-secrets.ts";
import { resolveDeployTargets } from "./deploy-targets.ts";
import { resolveMergeGates } from "./merge-gates.ts";
import { DEFAULT_CD_WORKFLOW, DEFAULT_CI_WORKFLOW } from "./shipped-workflows.ts";

/**
 * One section of config.json, or `null` for a value whose interior config.json
 * does not describe.
 *
 * `null` is not "anything goes" — it is "the key is recognised and something else
 * decides what may be in it". `auto_triggers`, `merge_gates` and `deploy.targets`
 * are all `null` here and all validated below by their own resolver.
 */
interface Section {
  /** Keys recognised by name. */
  readonly children?: Readonly<Record<string, Section | null>>;
  /**
   * Present when any name is legal at this level, and the shape each one takes.
   *
   * `agents` is the case that needs it: the names are the project's agents, which
   * this file cannot know. `labels` has both — three names with meanings and an
   * index signature for a project's own.
   */
  readonly anyName?: Section | null;
}

/**
 * config.json's recognised keys.
 *
 * `AtomaConfig` in `lib/types.ts` is the definition; this is the runtime mirror,
 * because an interface is erased before anything can consult it.
 * `config-contract.test.ts` extracts the interface's keys with TypeScript's own
 * parser and asserts this tree matches exactly — so a key added to the type and
 * not to this tree fails a test rather than being reported to an adopter as
 * unrecognised.
 *
 * That test is the whole reason this is safe to have. Without it the two lists
 * drift in the worst direction: a key the code reads, reported here as a typo.
 */
const CONFIG_SCHEMA: Section = {
  children: {
    merge_policy: null,
    base_branch: null,
    governed_paths: null,
    merge_gates: null,
    auto_triggers: null,
    checks: { children: { commands: null, secrets: null } },
    deploy: { children: { targets: null, secrets: null } },
    tools: { children: { secrets: null } },
    search: { children: { reranker_model: null } },
    environment: { children: { setup_commands: null } },
    workflows: { children: { ci: null, cd: null } },
    agents: { anyName: { children: { max_iterations: null } } },
    limits: { children: { agent_handoffs: null } },
    labels: { children: { in_progress: null, sub_issue: null, launched: null }, anyName: null },
  },
};

/**
 * Every key the schema recognises, as dotted paths, with `*` for a level where
 * any name is legal.
 *
 * Exported for `config-contract.test.ts`, which compares this against the same
 * projection of the `AtomaConfig` interface.
 */
export function knownConfigKeys(): string[] {
  const paths: string[] = [];
  const walk = (section: Section, prefix: string): void => {
    for (const [name, child] of Object.entries(section.children ?? {})) {
      const path = `${prefix}${name}`;
      paths.push(path);
      if (child) walk(child, `${path}.`);
    }
    if (section.anyName !== undefined) {
      const path = `${prefix}*`;
      paths.push(path);
      if (section.anyName) walk(section.anyName, `${path}.`);
    }
  };
  walk(CONFIG_SCHEMA, "");
  return paths.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys present in `value` that the schema does not recognise, as dotted paths. */
function unknownKeys(value: unknown, section: Section, prefix: string): string[] {
  if (!isRecord(value)) return [];
  const unknown: string[] = [];
  for (const [name, child] of Object.entries(value)) {
    const path = `${prefix}${name}`;
    const declared = section.children?.[name];
    if (declared !== undefined) {
      if (declared) unknown.push(...unknownKeys(child, declared, `${path}.`));
      continue;
    }
    if (section.anyName !== undefined) {
      if (section.anyName) unknown.push(...unknownKeys(child, section.anyName, `${path}.`));
      continue;
    }
    unknown.push(path);
  }
  return unknown;
}

/**
 * What the deliverable's own files say about itself, gathered by the caller.
 *
 * Passed in rather than read here so this module stays a pure function of its
 * input and the whole rule set is testable without a directory on disk.
 */
export interface DeliverableFacts {
  /** Parsed config.json. */
  readonly config: unknown;
  /** Agent names available, one per `agent-definitions/<name>.md`. */
  readonly agentNames: readonly string[];
  /** File names present in `.github/workflows/`, e.g. `atoma-check.yml`. */
  readonly workflowFiles: readonly string[];
}

/** The agent an `auto_triggers` entry names, or "" when it names one at run time. */
function triggerAgent(agent: string): string {
  // `$dispatch_agent` and anything else `$`-prefixed is filled in from the event
  // — see `match_trigger.ts`. There is no name here to check against a file.
  return agent.startsWith("$") ? "" : agent;
}

/**
 * Every way this config.json is inconsistent with the deliverable around it.
 *
 * Returns all of them rather than the first, so one pull request reports
 * everything an agent has to fix instead of one thing per round trip.
 */
export function configProblems(facts: DeliverableFacts): string[] {
  const problems: string[] = [];
  const { config, agentNames, workflowFiles } = facts;

  if (!isRecord(config)) {
    return ["`config.json` must be a JSON object."];
  }

  // ── keys nothing reads ────────────────────────────────────────────────────
  //
  // The failure this catches is total silence. A misspelled `governed_path` is
  // not an error anywhere: the reader asks for `governed_paths`, gets undefined,
  // takes the default, and the setting the author wrote has no effect at all.
  for (const key of unknownKeys(config, CONFIG_SCHEMA, "").sort()) {
    problems.push(`\`${key}\` in config.json is not a setting Atoma reads. Check the spelling.`);
  }

  // ── the four resolvers, run early ─────────────────────────────────────────
  const triggers = resolveAutoTriggers(config.auto_triggers);
  problems.push(...triggers.problems);
  problems.push(...resolveMergeGates(config.merge_gates).problems);

  // `deploy` and `checks` are read for their SHAPE only, which is not the same as
  // taking direction from them. #414 rules out letting an adopter's pipeline
  // configure this validation — running their commands, deciding what to check
  // from their config. Asking whether `deploy.targets` is a well-formed array of
  // targets is this deliverable validating itself, and the alternative is what
  // happens today: `resolveDeployTargets` reports it after the merge, from the
  // deploy run, where nobody is watching.
  const deploy = isRecord(config.deploy) ? config.deploy : {};
  problems.push(...resolveDeployTargets(deploy.targets).problems);

  const checks = isRecord(config.checks) ? config.checks : {};
  const tools = isRecord(config.tools) ? config.tools : {};
  problems.push(...resolveDeclaredSecrets(tools.secrets, SECRET_DESTINATIONS.tools).problems);
  problems.push(...resolveDeclaredSecrets(checks.secrets, SECRET_DESTINATIONS.checks).problems);
  problems.push(...resolveDeclaredSecrets(deploy.secrets, SECRET_DESTINATIONS.deploy).problems);

  // ── names that have to resolve to a file ──────────────────────────────────
  //
  // Only checked when the definitions were found at all. An empty set means the
  // directory was not there, and reporting every agent as missing would bury the
  // one problem that matters under noise.
  if (agentNames.length > 0) {
    const known = new Set(agentNames);
    const available = [...known].sort().join(", ");

    for (const trigger of triggers.triggers) {
      const agent = triggerAgent(trigger.agent);
      if (agent && !known.has(agent)) {
        problems.push(
          `\`auto_triggers\` routes \`${trigger.event}\` to '${agent}', which has no ` +
            `agent-definitions/${agent}.md. The event would dispatch a run that cannot start. ` +
            `Available: ${available}`,
        );
      }
    }

    if (isRecord(config.agents)) {
      for (const name of Object.keys(config.agents).sort()) {
        if (!known.has(name)) {
          problems.push(
            `\`agents.${name}\` configures an agent with no agent-definitions/${name}.md, ` +
              `so nothing reads it. Available: ${available}`,
          );
        }
      }
    }
  } else {
    problems.push("No agent definitions were found. `.github/atoma/agent-definitions/*.md` is empty or missing.");
  }

  // ── the two workflows a dispatch names ────────────────────────────────────
  //
  // A name that is not a file fails at `gh workflow run`, which is the moment
  // there is no longer anywhere to report it: the CI dispatch fails inside
  // `validate_pull_request.ts` and the pull request loses its required check with
  // no agent scheduled after it.
  if (workflowFiles.length > 0) {
    const present = new Set(workflowFiles);
    const workflows = isRecord(config.workflows) ? config.workflows : {};
    for (const [kind, fallback] of [
      ["ci", DEFAULT_CI_WORKFLOW],
      ["cd", DEFAULT_CD_WORKFLOW],
    ] as const) {
      const configured = typeof workflows[kind] === "string" ? (workflows[kind] as string).trim() : "";
      const effective = configured || fallback;
      if (!present.has(effective)) {
        problems.push(
          `\`workflows.${kind}\` resolves to '${effective}', which is not a file in .github/workflows/. ` +
            (configured ? "Check the name." : "The shipped default is missing from this repository."),
        );
      }
    }
  }

  // ── labels ───────────────────────────────────────────────────────────────
  //
  // A label configured as "" is applied as "" and matched as "", so a filter on it
  // finds nothing and the count that gates a parent's dispatch never reaches zero.
  if (isRecord(config.labels)) {
    for (const [key, value] of Object.entries(config.labels)) {
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`\`labels.${key}\` must be a non-empty label name.`);
      }
    }
  }

  return problems;
}

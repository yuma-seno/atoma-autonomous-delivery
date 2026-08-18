/**
 * types.ts — shared type definitions, the one canonical copy used by every
 * script and MCP server in this repo.
 */

export interface AutoTrigger {
  event: string;
  agent: string;
  condition?: "changes_requested" | "non_draft" | "atoma:dispatch";
}

export interface AtomaConfig {
  merge_policy: "auto" | "manual" | string;
  /**
   * Branch an issue's work starts from and its pull request targets.
   *
   * Unset means the repository's default branch, which is what most projects
   * want and why this ships unset. It exists for the one arrangement the default
   * cannot express: keeping `main` as the default branch, for releases and for
   * what GitHub shows first, while agents' work accumulates somewhere else.
   *
   * Fixing a branching strategy here would be the wrong trade. Requiring `main`
   * shuts out projects with an integration branch; assuming one saddles every
   * other project with a branch it does not use.
   */
  base_branch?: string;
  /**
   * Paths whose change takes the merge away from an agent and gives it to a
   * person — workflows, runner scripts, agent definitions, tool configuration,
   * rulesets.
   *
   * Unset takes `DEFAULT_GOVERNED_PATHS`, the whole deployed `.github/` control
   * surface. Set it to add a repository's own — a template that generates its
   * workflows from source has a second place those live — or to hand a corner of
   * `.github/` back, which is better done by naming the parts you do want
   * governed than by trusting a shorter default. Set it to `[]` to turn the gate
   * off, which is a decision rather than an accident.
   *
   * A pattern is a literal path or a directory followed by `/**`.
   */
  governed_paths?: string[];
  /**
   * Conditions under which an agent must not merge, beyond what a path can say.
   *
   * `governed_paths` above is the special case: paths, and nothing else. This is
   * the general form — "only when a migration is ADDED", "only when the pull
   * request carries this label", "only when the title says BREAKING" — for the
   * situations a project knows about and Atoma could not have guessed.
   *
   * Same outcome as `governed_paths`: the agent reviews and reports, and a person
   * merges. Not a required status check, because a required check stops people too.
   *
   * ```json
   * "merge_gates": [
   *   {
   *     "reason": "新しいマイグレーションを含むため、人間が確認してください",
   *     "when": { "files_added": ["db/migrations/**"] }
   *   }
   * ]
   * ```
   *
   * Validated by `resolveMergeGates`; see `domain/merge-gates.ts` for the
   * condition set, why it is configuration rather than a script, and why a
   * misspelled condition is an error rather than a gate that quietly never fires.
   */
  merge_gates?: unknown;
  /**
   * What this project runs to verify a change, as commands.
   *
   * Commands and not a workflow file because an agent can write one and not the
   * other: GITHUB_TOKEN is refused on `.github/workflows/**` by identity, on
   * every path and branch. `atoma-check.yml` runs whatever is named here, so a
   * project's verification can be authored by an agent and reviewed as an
   * ordinary diff.
   *
   * Unset means this project verifies nothing through Atoma; point
   * `workflows.ci` at a workflow of your own instead.
   */
  checks?: {
    /** Run in order, stopping at the first failure. */
    commands?: string[];
    /** Repository secrets `atoma-check.yml` may reach. See `tools.secrets`. */
    secrets?: string[];
  };
  /**
   * What this project deploys, and which event deploys it.
   *
   * Validated by `resolveDeployTargets`. See `domain/deploy-targets.ts` for why
   * the trigger is configuration rather than the workflow's own `on:`.
   */
  deploy?: {
    targets?: unknown;
    /** Repository secrets `atoma-deploy.yml` may reach. See `tools.secrets`. */
    secrets?: string[];
  };
  /** Settings for the tool servers an agent calls. */
  tools?: {
    /**
     * Repository secrets a run hands to the agent, for tool servers that talk to
     * something outside GitHub.
     *
     * Unset, and `[]`, mean the agent sees only the credentials the run needs to
     * work at all — which is the default and what most projects want. Naming one
     * here is a deliberate widening of what the agent can read, which is why it
     * lives in a versioned, reviewable file rather than in repository settings.
     *
     * Each entry is the name of a secret that already exists in the repository;
     * this declares which of them may travel, it does not create them. Validated
     * by `resolveToolSecrets` — a name the run already uses for itself, a
     * duplicate, or more than `TOOL_SECRET_SLOTS` of them fails the run with a
     * message rather than being quietly dropped.
     *
     * Nested under the feature that consumes it, rather than named for it at the
     * top level, because it is one of several destinations a credential can have
     * — these reach the agent's own process, and nothing else should.
     */
    secrets?: string[];
  };
  search?: {
    /**
     * Cross encoder used to rank issue search results.
     *
     * The one model choice that changes the answer: the first stage is BM25,
     * which has no model, and this decides the order of what it finds. Any
     * transformers.js-compatible sequence-classification model works.
     */
     reranker_model?: string;
  };
  environment?: {
    setup_commands?: string[];
  };
  agents?: Record<string, { max_iterations?: number }>;
  /**
   * Workflows of this project's own that Atoma should dispatch instead of the
   * shipped ones.
   *
   * Set these only when a pipeline cannot be expressed as `checks.commands` or
   * `deploy.targets` — a deployment approval gate, an unusual trigger, a job
   * needing permissions the shipped workflows do not declare. Otherwise leave
   * both unset: the default is `atoma-check.yml` / `atoma-deploy.yml`, which run
   * this project's configured commands and need no workflow authoring.
   */
  workflows?: {
    /** Put a required check on a pull request's head commit before merging. Defaults to `atoma-check.yml`. */
    ci?: string;
    /** Dispatched after a successful merge. Defaults to `atoma-deploy.yml`, which no-ops with no merge targets. */
    cd?: string;
  };
  labels?: {
    in_progress?: string;
    sub_issue?: string;
    launched?: string;
    [key: string]: string | undefined;
  };
  auto_triggers?: AutoTrigger[];
}

/** Minimal shape of `gh issue view --json author` (NOT the REST `.user.type` shape). */
export interface GhIssueAuthor {
  author?: {
    is_bot?: boolean;
    login?: string;
  };
}

export interface GhIssueSummary {
  number: number;
  title: string;
  state: string;
  labels?: { name: string }[];
}

export interface GhPrSummary {
  number: number;
  title: string;
  url: string;
}

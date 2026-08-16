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
   * person — workflows, agent definitions, tool configuration, rulesets.
   *
   * Unset takes `DEFAULT_GOVERNED_PATHS`, which names the deployed `.github/`
   * control surface. Set it to add a repository's own — a template that
   * generates its workflows from source has a second place those live. Set it to
   * `[]` to turn the gate off, which is a decision rather than an accident.
   *
   * A pattern is a literal path or a directory followed by `/**`.
   */
  governed_paths?: string[];
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
   * Names of this project's own workflows, which Atoma dispatches by name.
   *
   * Both are project-specific, so the template ships neither: an adopter's CI is
   * not necessarily `ci.yml`, and most projects have no deployment workflow that
   * needs dispatching at all.
   */
  workflows?: {
    /** Put a required check on a pull request's head commit before merging. Defaults to `ci.yml`. */
    ci?: string;
    /** Dispatched after a successful merge. Unset means no post-merge dispatch. */
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

/** A single {issue, agent} dispatch task for launch_sub_agent. */
export interface SubAgentTask {
  issue: number;
  agent: string;
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

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

/**
 * Shared type definitions for the Atoma tools/scripts subtree.
 *
 * NOTE: Everything under `.github/atoma/**` must stay self-contained (no
 * imports reaching outside `.github/`) -- the README instructs users to copy
 * just the `.github/` directory into their own repository, so this whole
 * subtree is the distributable unit.
 */

export interface AutoTrigger {
  event: string;
  agent: string;
  condition?: "changes_requested" | "non_draft" | "atoma:dispatch";
}

export interface AtomaConfig {
  version: number;
  merge_policy: "auto" | "manual" | string;
  environment?: {
    description?: string;
    setup_commands?: string[];
  };
  agents?: Record<string, { max_iterations?: number }>;
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

/** JSON-RPC 2.0 request as received over MCP stdio transport. */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: TParams;
}

export interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Minimal shape of `gh issue view --json author` (NOT the REST `.user.type` shape). */
export interface GhIssueAuthor {
  author?: {
    is_bot?: boolean;
    login?: string;
  };
}

export interface GhIssueBody {
  body?: string;
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

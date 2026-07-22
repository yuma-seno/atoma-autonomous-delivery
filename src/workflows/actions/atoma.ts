/**
 * atoma-actions.ts — Typed wrappers for Atoma's own composite GitHub Actions
 * (`yuma-seno/atoma/github/actions/*`), built from the actual `action.yml`
 * input/output contracts. See `base.ts` for the design rationale.
 */
import { CustomAction, type StepBaseProps } from "./base.ts";

const REF = "yuma-seno/atoma/github/actions";

// ── setup-runtime ───────────────────────────────────────────────────────────
export interface SetupRuntimeInputs {
  tools_file?: string;
  scripts_dir?: string;
}

export class SetupRuntimeAction extends CustomAction<SetupRuntimeInputs> {
  constructor(props: StepBaseProps & { with?: SetupRuntimeInputs } = {}) {
    super(`${REF}/setup-runtime@main`, { ...props, with: props.with ?? {} });
  }
}

// ── prepare ──────────────────────────────────────────────────────────────
export interface PrepareInputs {
  type: string;
  number: string;
  agent_name: string;
  max_diff_chars?: string;
  orchestration_file?: string;
}

export type PrepareOutputs = "new_event_count" | "context_snapshot_hash" | "context_event_count" | "resolved_number";

export class PrepareAction extends CustomAction<PrepareInputs, PrepareOutputs> {
  constructor(props: StepBaseProps & { with: PrepareInputs }) {
    super(`${REF}/prepare@main`, props, [
      "new_event_count",
      "context_snapshot_hash",
      "context_event_count",
      "resolved_number",
    ]);
  }
}

// ── run ──────────────────────────────────────────────────────────────────
export interface RunAgentInputs {
  agent_name: string;
  agent_def_dir?: string;
  tools_file?: string;
  orchestration_file?: string;
  openai_api_key?: string;
  openai_base_url?: string;
  anthropic_api_key?: string;
  atoma_provider?: string;
  max_iterations?: string;
  atoma_version?: string;
  after_iteration_hook?: string;
  github_token?: string;
  issue_number?: string;
  notify_login?: string;
}

export type RunAgentOutputs = "result" | "directive" | "max_iterations_reached" | "chain_continues";

export class RunAgentAction extends CustomAction<RunAgentInputs, RunAgentOutputs> {
  constructor(props: StepBaseProps & { with: RunAgentInputs }) {
    super(`${REF}/run@main`, props, ["result", "directive", "max_iterations_reached", "chain_continues"]);
  }
}

// ── post-result ──────────────────────────────────────────────────────────
export interface PostResultInputs {
  agent_name: string;
  number: string;
  type: string;
  notify?: string;
  job_status: string;
  atoma_outcome?: string;
  directive?: string;
  chain_continues?: string;
  new_event_count?: string;
  max_iterations_reached?: string;
  context_snapshot_hash?: string;
  context_event_count?: string;
  resolved_number?: string;
}

export type PostResultOutputs = "comment_id";

export class PostResultAction extends CustomAction<PostResultInputs, PostResultOutputs> {
  constructor(props: StepBaseProps & { with: PostResultInputs }) {
    super(`${REF}/post-result@main`, props, ["comment_id"]);
  }
}

// ── dispatch-next ────────────────────────────────────────────────────────
export interface DispatchNextInputs {
  agent_name: string;
  number: string;
  type: string;
  notify?: string;
  directive?: string;
  max_iterations_reached?: string;
  new_event_count?: string;
  atoma_outcome?: string;
  orchestration_file?: string;
}

export class DispatchNextAction extends CustomAction<DispatchNextInputs> {
  constructor(props: StepBaseProps & { with: DispatchNextInputs }) {
    super(`${REF}/dispatch-next@main`, props);
  }
}

// ── parse-comment-command ────────────────────────────────────────────────
export interface ParseCommentCommandInputs {
  body: string;
}

export type ParseCommentCommandOutputs = "matched" | "agent";

export class ParseCommentCommandAction extends CustomAction<ParseCommentCommandInputs, ParseCommentCommandOutputs> {
  constructor(props: StepBaseProps & { with: ParseCommentCommandInputs }) {
    super(`${REF}/parse-comment-command@main`, props, ["matched", "agent"]);
  }
}

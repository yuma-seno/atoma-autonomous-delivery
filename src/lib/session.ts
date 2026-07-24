/**
 * session.ts — shared `Session`/`SessionMessage` shape for the
 * `session.json` files this repo reads and mutates at several points
 * (persisted on the orphan `atoma-data` branch, restored/saved via
 * `restore_agent_session.ts`/`save_agent_session.ts`, and read/mutated
 * in-place by `build_context_session.ts`, `record_run_metadata.ts`,
 * `manage_dispatch_loop.ts`, `inject_uncommitted_notice.ts`, and
 * `lib/inject-sub-results.ts`). The one canonical definition, replacing 5
 * independently-hand-rolled (near-identical, slightly-narrowed-per-use)
 * local interfaces.
 *
 * This is a TS-side reasonable SUBSET of the real shape the `atoma` Rust
 * core itself reads/writes (see that sibling repo's `src/domain/session.rs`
 * if the exact wire format ever needs re-verifying against the actual
 * source of truth) -- the `[key: string]: unknown` index signature on both
 * interfaces exists specifically so a script that only cares about a few
 * fields can still round-trip the rest of a real session.json untouched.
 */

export interface SessionMessageMetadata {
  /** Set by record_run_metadata.ts, read by build_context_session.ts to exclude an agent's own past result comments from its own future shared context. */
  github_comment_id?: string | number;
  agent?: string;
  [key: string]: unknown;
}

export interface SessionMessage {
  role: string;
  content?: string;
  atoma_metadata?: SessionMessageMetadata;
  [key: string]: unknown;
}

export interface SessionGithubContext {
  snapshot_hash?: string;
  event_count?: number;
  agent?: string;
  type?: string;
  resolved_number?: string | number;
  auto_dispatch_count?: number;
}

export interface SessionMetadata {
  github_context?: SessionGithubContext;
  [key: string]: unknown;
}

export interface Session {
  // Optional, not just realistically-always-present: manage_dispatch_loop.ts
  // only ever touches `.metadata` and is tested against synthetic
  // metadata-only objects, so this must type-check without a `messages`
  // field. Every consumer that actually iterates messages already guards
  // with `session.messages ?? []` (or, for record_run_metadata.ts /
  // inject_uncommitted_notice.ts, requires it be present via their own
  // narrower local usage -- see those files).
  messages?: SessionMessage[];
  metadata?: SessionMetadata;
  [key: string]: unknown;
}

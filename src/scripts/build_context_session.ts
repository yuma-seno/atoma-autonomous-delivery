#!/usr/bin/env bun
/**
 * build_context_session.ts — Build a temporary context-session.json from
 * GitHub events.
 *
 * Philosophy: GitHub conversation is shared context rebuilt on each run.
 * The cached session.json remains agent-local state: assistant replies,
 * tool calls, and per-agent working memory. This keeps orchestration
 * comments visible across agents while preserving each agent's own
 * tool-call history.
 *
 * Algorithm:
 *   1. Load the cached per-agent session (optional) to inspect:
 *        - assistant github_comment_id values posted by this agent
 *        - the previously processed shared-context snapshot hash
 *   2. Filter fetched GitHub events:
 *        - keep issue/PR bodies, diffs, human comments, and other-agent comments
 *        - exclude this agent's own result comments
 *        - apply the agent's configured shared_context include/exclude policy, if any
 *   3. Convert the filtered events into context-session.json user messages.
 *   4. Compute a snapshot hash for change detection.
 *   5. Write new_event_count/context_snapshot_hash/context_event_count to $GITHUB_OUTPUT.
 *
 * Usage:
 *   build_context_session.ts --events events.json --agent-name orchestrator \
 *     [--session session.json] [--config config.json] --out context-session.json
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defineScript } from "./lib/script-ref.ts";
import type { GithubEvent } from "./fetch_events.ts";
import type { Session, SessionMessage } from "../lib/session.ts";

export interface BuildContextSessionArgs {
  events: string;
  "agent-name": string;
  config?: string;
  session?: string;
  out: string;
}

export const ref = defineScript<BuildContextSessionArgs>(import.meta.url);

const GITHUB_CONTEXT_LAYER = "github-context";
const AGENT_MARKER_RE = /^<!--\s*atoma:agent=([a-z][a-z0-9-]*)\s*-->$/;

interface SharedContextConfig {
  agents?: Record<string, { shared_context?: { include_event_types?: string[]; exclude_event_types?: string[] } }>;
}

interface ContextSessionMessage {
  role: "user";
  content: string;
  atoma_metadata: {
    source: "github";
    layer: string;
    event_type: string;
    id: string | number;
    author: string;
    created_at: string;
    sha?: string;
  };
}

export interface BuildContextSessionResult {
  contextSession: {
    messages: ContextSessionMessage[];
    metadata: { source: string; agent: string; snapshot_hash: string; event_count: number };
  };
  changedCount: number;
  snapshotHash: string;
  eventCount: number;
}

function normalizeId(val: string | number | undefined): string | undefined {
  return val === undefined ? undefined : String(val);
}

function buildOwnCommentIds(session: Session, agentName: string): Set<string> {
  const ownIds = new Set<string>();
  for (const msg of session.messages ?? []) {
    const meta = msg.atoma_metadata;
    if (msg.role !== "assistant" || !meta || meta.github_comment_id === undefined) continue;
    if (meta.agent !== undefined && meta.agent !== agentName) continue;
    const id = normalizeId(meta.github_comment_id);
    if (id !== undefined) ownIds.add(id);
  }
  return ownIds;
}

function extractResultCommentAgent(event: GithubEvent): string | undefined {
  if (!event.author.endsWith("[bot]")) return undefined;
  if (!event.content) return undefined;
  const firstLine = event.content.split("\n")[0]!.trim();
  return AGENT_MARKER_RE.exec(firstLine)?.[1];
}

function isSelfEvent(event: GithubEvent, agentName: string, ownCommentIds: Set<string>): boolean {
  const eventId = normalizeId(event.id);
  if (eventId !== undefined && ownCommentIds.has(eventId)) return true;
  return extractResultCommentAgent(event) === agentName;
}

function contextPolicy(config: SharedContextConfig, agentName: string): { include?: Set<string>; exclude: Set<string> } {
  const sharedContext = config.agents?.[agentName]?.shared_context;
  if (!sharedContext) return { exclude: new Set() };
  return {
    include: sharedContext.include_event_types ? new Set(sharedContext.include_event_types) : undefined,
    exclude: new Set(sharedContext.exclude_event_types ?? []),
  };
}

function filterEventsForAgent(
  events: GithubEvent[],
  agentName: string,
  ownCommentIds: Set<string>,
  config: SharedContextConfig,
): GithubEvent[] {
  const { include, exclude } = contextPolicy(config, agentName);
  const filtered: GithubEvent[] = [];
  for (const event of events) {
    if (isSelfEvent(event, agentName, ownCommentIds)) {
      console.error(`  Skipping current agent comment from shared context: id=${event.id}`);
      continue;
    }
    if (include && !include.has(event.event_type)) continue;
    if (exclude.has(event.event_type)) continue;
    filtered.push(event);
  }
  return filtered;
}

function eventToUserMessage(event: GithubEvent): ContextSessionMessage {
  return {
    role: "user",
    content: event.content,
    atoma_metadata: {
      source: "github",
      layer: GITHUB_CONTEXT_LAYER,
      event_type: event.event_type,
      id: event.id,
      author: event.author ?? "unknown",
      created_at: event.created_at ?? "",
      ...(event.sha !== undefined ? { sha: event.sha } : {}),
    },
  };
}

/** Deterministic JSON serialization (recursively sorted object keys, no whitespace) for stable hashing. */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

function snapshotHashForEvents(events: GithubEvent[]): string {
  return createHash("sha256").update(canonicalStringify(events)).digest("hex");
}

function previousSnapshotHash(session: Session): string | undefined {
  return session.metadata?.github_context?.snapshot_hash;
}

export function buildContextSession(
  session: Session,
  events: GithubEvent[],
  agentName: string,
  config: SharedContextConfig = {},
): BuildContextSessionResult {
  const ownCommentIds = buildOwnCommentIds(session, agentName);
  const filteredEvents = filterEventsForAgent(events, agentName, ownCommentIds, config);
  const currentHash = snapshotHashForEvents(filteredEvents);
  const previousHash = previousSnapshotHash(session);

  let changedCount: number;
  if (previousHash === currentHash) changedCount = 0;
  else if (previousHash === undefined) changedCount = filteredEvents.length;
  else changedCount = 1;

  return {
    contextSession: {
      messages: filteredEvents.map(eventToUserMessage),
      metadata: {
        source: GITHUB_CONTEXT_LAYER,
        agent: agentName,
        snapshot_hash: currentHash,
        event_count: filteredEvents.length,
      },
    },
    changedCount,
    snapshotHash: currentHash,
    eventCount: filteredEvents.length,
  };
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      events: { type: "string" },
      "agent-name": { type: "string" },
      config: { type: "string" },
      session: { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.events || !values["agent-name"] || !values.out) {
    console.error(
      "usage: build_context_session.ts --events events.json --agent-name AGENT [--session session.json] [--config config.json] --out context-session.json",
    );
    process.exit(2);
  }

  const session: Session = values.session && existsSync(values.session) ? JSON.parse(readFileSync(values.session, "utf8")) : { messages: [] };
  const events = JSON.parse(readFileSync(values.events, "utf8")) as GithubEvent[];
  const config: SharedContextConfig = values.config && existsSync(values.config) ? JSON.parse(readFileSync(values.config, "utf8")) : {};

  const { contextSession, changedCount, snapshotHash, eventCount } = buildContextSession(session, events, values["agent-name"], config);

  writeFileSync(values.out, JSON.stringify(contextSession, null, 2));

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `new_event_count=${changedCount}\ncontext_snapshot_hash=${snapshotHash}\ncontext_event_count=${eventCount}\n`,
    );
  }

  console.error(
    `Context build complete: ${events.length} events fetched, ${eventCount} shared messages, changed=${changedCount}`,
  );
}

if (import.meta.main) main();

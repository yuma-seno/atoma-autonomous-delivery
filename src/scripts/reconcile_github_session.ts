#!/usr/bin/env bun
/**
 * reconcile_github_session.ts — Reconcile GitHub events into the durable
 * per-agent session.
 *
 * GitHub messages are persisted in session.json so the original task remains
 * a stable early prompt prefix. Existing events update in place and genuinely
 * new events append after prior agent history, preserving cross-run chronology
 * and provider prompt-cache reuse.
 *
 * Algorithm:
 *   1. Load the cached per-agent session (optional) to inspect:
 *        - assistant github_comment_id values posted by this agent
 *        - the previously processed shared-context snapshot hash
 *   2. Filter fetched GitHub events:
 *        - keep issue/PR bodies, diffs, human comments, and other-agent comments
 *        - exclude this agent's own result comments
 *        - apply the agent's configured shared_context include/exclude policy, if any
 *   3. Reconcile the filtered events into session.json by stable event ID.
 *   4. Compute a snapshot hash for change detection.
 *   5. Write new_event_count/context_snapshot_hash/context_event_count/messages_before
 *      to $GITHUB_OUTPUT.
 *
 * Usage:
 *   reconcile_github_session.ts --events events.json --agent-name orchestrator \
 *     --session session.json [--config config.json] --out session.json
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { defineScript } from "./lib/script-ref.ts";
import type { GithubEvent } from "./fetch_events.ts";
import type { Session, SessionMessage, SessionMessageMetadata } from "../lib/session.ts";
import { AGENT_TAG, LLM_CONTEXT_TAG } from "../lib/tags.ts";
import { contentWithImages, type ContentBlock } from "../lib/issue-images.ts";

export interface ReconcileGithubSessionArgs {
  events: string;
  "agent-name": string;
  /** Path to the running agent's definition, read for its `vision` field. */
  "agent-def"?: string;
  config?: string;
  session?: string;
  out: string;
}

export const ref = defineScript<ReconcileGithubSessionArgs>(import.meta.url);

const GITHUB_CONTEXT_LAYER = "github-context";

interface SharedContextConfig {
  agents?: Record<string, { shared_context?: { include_event_types?: string[]; exclude_event_types?: string[] } }>;
}

interface GithubEventMessage extends SessionMessage {
  role: "user";
  /**
   * Text, or blocks when the event referenced a picture the agent can read.
   *
   * A string for every event that has none, which is nearly all of them, so a
   * session written before this looks no different from one written after.
   */
  content: string | ContentBlock[];
  atoma_metadata: SessionMessageMetadata & {
    source: "github";
    layer: string;
    event_type: string;
    id: string | number;
    author: string;
    created_at: string;
    sha?: string;
  };
}

export interface ReconcileGithubSessionResult {
  mergedSession: Session;
  changedCount: number;
  snapshotHash: string;
  eventCount: number;
}

function githubEventKey(message: SessionMessage): string | undefined {
  const metadata = message.atoma_metadata;
  if (metadata?.source !== "github" || metadata.layer !== GITHUB_CONTEXT_LAYER) return undefined;
  if (metadata.event_type === undefined || metadata.id === undefined) return undefined;
  return `${String(metadata.event_type)}:${String(metadata.id)}`;
}

function githubEventKeyFromEvent(event: GithubEvent): string {
  return `${event.event_type}:${String(event.id)}`;
}

function deletedGithubMessage(message: SessionMessage): SessionMessage {
  if (message.atoma_metadata?.deleted === true) return message;
  return {
    role: "user",
    content: `[Deleted GitHub ${String(message.atoma_metadata?.event_type ?? "event")}]`,
    atoma_metadata: { ...message.atoma_metadata, deleted: true },
  };
}

function reconcilePersistedGithubContext(
  session: Session,
  messages: GithubEventMessage[],
  fetchedEventKeys: ReadonlySet<string>,
): Session {
  const incomingByKey = new Map(messages.map((message) => [githubEventKey(message)!, message]));
  const seen = new Set<string>();
  const reconciled: SessionMessage[] = [];

  for (const message of session.messages ?? []) {
    const key = githubEventKey(message);
    if (key === undefined) {
      reconciled.push(message);
      continue;
    }

    const replacement = incomingByKey.get(key);
    if (replacement !== undefined && !seen.has(key)) {
      reconciled.push(replacement);
      seen.add(key);
    } else if (!fetchedEventKeys.has(key) && !seen.has(key)) {
      reconciled.push(deletedGithubMessage(message));
      seen.add(key);
    }
  }

  for (const message of messages) {
    const key = githubEventKey(message)!;
    if (!seen.has(key)) {
      reconciled.push(message);
      seen.add(key);
    }
  }

  return { ...session, messages: reconciled };
}

/**
 * Reconcile the current GitHub snapshot into the durable agent session.
 * Existing events keep their position, changed events update in place, and
 * genuinely new events append after the agent history that preceded them.
 */
export function mergeGithubContext(
  session: Session,
  messages: GithubEventMessage[],
  fetchedEventKeys: ReadonlySet<string> = new Set(messages.map((message) => githubEventKey(message)!)),
): Session {
  const existingMessages = session.messages ?? [];
  if (session.metadata?.github_context?.version === 1) {
    return reconcilePersistedGithubContext(session, messages, fetchedEventKeys);
  }

  const firstHistoryIndex = existingMessages.findIndex((message) => message.role !== "system");
  const insertionIndex = firstHistoryIndex === -1 ? existingMessages.length : firstHistoryIndex;
  return {
    ...session,
    messages: [
      ...existingMessages.slice(0, insertionIndex),
      ...messages,
      ...existingMessages.slice(insertionIndex),
    ],
  };
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
  return AGENT_TAG.read(firstLine);
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
    if (event.author.endsWith("[bot]") && LLM_CONTEXT_TAG.read(event.content) === "exclude") {
      console.error(`  Skipping operational notification from LLM context: id=${event.id}`);
      continue;
    }
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

/**
 * Whether the agent's model can look at a picture.
 *
 * Read from the definition's `vision` field, and false when it cannot be read.
 * Sending an image to a model that has no way to take one is an API error that
 * loses the whole run, so the safe answer is the default.
 */
export function agentReadsImages(agentDefPath: string | undefined): boolean {
  if (!agentDefPath || !existsSync(agentDefPath)) return false;
  return /^vision:\s*true\s*$/m.test(readFileSync(agentDefPath, "utf8"));
}

function eventToUserMessage(event: GithubEvent, vision: boolean): GithubEventMessage {
  return {
    role: "user",
    content: vision ? contentWithImages(event.content) : event.content,
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

export function reconcileGithubSession(
  session: Session,
  events: GithubEvent[],
  agentName: string,
  config: SharedContextConfig = {},
  vision = false,
): ReconcileGithubSessionResult {
  const ownCommentIds = buildOwnCommentIds(session, agentName);
  const filteredEvents = filterEventsForAgent(events, agentName, ownCommentIds, config);
  const currentHash = snapshotHashForEvents(filteredEvents);
  const previousHash = previousSnapshotHash(session);
  const contextMessages = filteredEvents.map((event) => eventToUserMessage(event, vision));
  const fetchedEventKeys = new Set(events.map(githubEventKeyFromEvent));

  let changedCount: number;
  if (previousHash === currentHash) changedCount = 0;
  else if (previousHash === undefined) changedCount = filteredEvents.length;
  else changedCount = 1;

  const mergedSession = mergeGithubContext(session, contextMessages, fetchedEventKeys);
  mergedSession.metadata = {
    ...mergedSession.metadata,
    github_context: {
      ...mergedSession.metadata?.github_context,
      version: 1,
      snapshot_hash: currentHash,
      event_count: filteredEvents.length,
      agent: agentName,
    },
  };

  return {
    mergedSession,
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
      "agent-def": { type: "string" },
      config: { type: "string" },
      session: { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.events || !values["agent-name"] || !values.session || !values.out) {
    console.error(
      "usage: reconcile_github_session.ts --events events.json --agent-name AGENT --session session.json [--config config.json] --out session.json",
    );
    process.exit(2);
  }

  const session: Session = existsSync(values.session) ? JSON.parse(readFileSync(values.session, "utf8")) : { messages: [] };
  const events = JSON.parse(readFileSync(values.events, "utf8")) as GithubEvent[];
  const config: SharedContextConfig = values.config && existsSync(values.config) ? JSON.parse(readFileSync(values.config, "utf8")) : {};

  const { mergedSession, changedCount, snapshotHash, eventCount } = reconcileGithubSession(
    session,
    events,
    values["agent-name"],
    config,
    agentReadsImages(values["agent-def"]),
  );

  writeFileSync(values.out, JSON.stringify(mergedSession, null, 2) + "\n");

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `new_event_count=${changedCount}\ncontext_snapshot_hash=${snapshotHash}\ncontext_event_count=${eventCount}\n` +
        // Where this run's own messages will begin. Everything below this index was
        // written by an earlier run or is the GitHub context put in front of this one,
        // and `post_result_comment.ts` needs the boundary: without it, a run that
        // stopped before writing anything salvages the LAST run's conclusion and
        // presents it as a fragment of this one. Measured on #568.
        `messages_before=${mergedSession.messages?.length ?? 0}\n`,
    );
  }

  console.error(
    `Context build complete: ${events.length} events fetched, ${eventCount} shared messages, changed=${changedCount}`,
  );
}

if (import.meta.main) main();

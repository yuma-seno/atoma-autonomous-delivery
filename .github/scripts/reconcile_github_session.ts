#!/usr/bin/env bun
// @bun

// src/scripts/reconcile_github_session.ts
import { createHash } from "crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { parseArgs } from "util";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/lib/agent-name.ts
var AGENT_NAME_PATTERN = "[a-z][a-z0-9-]*";
var AGENT_NAME_RE = new RegExp(`^${AGENT_NAME_PATTERN}$`);

// src/lib/tags.ts
function makeTag(key, valuePattern, parse, render) {
  const re = new RegExp(`<!--\\s*atoma:${key}=(${valuePattern})\\s*-->`);
  return {
    write: (value) => `<!-- atoma:${key}=${render(value)} -->`,
    read: (text) => {
      const m = re.exec(text);
      return m ? parse(m[1]) : undefined;
    },
    has: (text) => re.test(text)
  };
}
function numericTag(key) {
  return makeTag(key, "\\d+", Number, String);
}
function stringTag(key, valuePattern) {
  return makeTag(key, valuePattern, (raw) => raw, (value) => value);
}
var PARENT_TAG = numericTag("parent");
var PARENT_ISSUE_TAG = numericTag("parent-issue");
var NOTIFY_TAG = stringTag("notify", "[A-Za-z0-9-]+");
var ORIGIN_AGENT_TAG = stringTag("origin-agent", AGENT_NAME_PATTERN);
var DISPATCH_TAG = stringTag("dispatch", AGENT_NAME_PATTERN);
var AGENT_TAG = stringTag("agent", AGENT_NAME_PATTERN);
var LLM_CONTEXT_TAG = stringTag("llm-context", "include|exclude");
var AGGREGATED_TAG = numericTag("aggregated");
var SUB_RESULT_TAG = numericTag("sub-result");

// src/scripts/reconcile_github_session.ts
var ref = defineScript(import.meta.url);
var GITHUB_CONTEXT_LAYER = "github-context";
function githubEventKey(message) {
  const metadata = message.atoma_metadata;
  if (metadata?.source !== "github" || metadata.layer !== GITHUB_CONTEXT_LAYER)
    return;
  if (metadata.event_type === undefined || metadata.id === undefined)
    return;
  return `${String(metadata.event_type)}:${String(metadata.id)}`;
}
function githubEventKeyFromEvent(event) {
  return `${event.event_type}:${String(event.id)}`;
}
function deletedGithubMessage(message) {
  if (message.atoma_metadata?.deleted === true)
    return message;
  return {
    role: "user",
    content: `[Deleted GitHub ${String(message.atoma_metadata?.event_type ?? "event")}]`,
    atoma_metadata: { ...message.atoma_metadata, deleted: true }
  };
}
function reconcilePersistedGithubContext(session, messages, fetchedEventKeys) {
  const incomingByKey = new Map(messages.map((message) => [githubEventKey(message), message]));
  const seen = new Set;
  const reconciled = [];
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
    const key = githubEventKey(message);
    if (!seen.has(key)) {
      reconciled.push(message);
      seen.add(key);
    }
  }
  return { ...session, messages: reconciled };
}
function mergeGithubContext(session, messages, fetchedEventKeys = new Set(messages.map((message) => githubEventKey(message)))) {
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
      ...existingMessages.slice(insertionIndex)
    ]
  };
}
function normalizeId(val) {
  return val === undefined ? undefined : String(val);
}
function buildOwnCommentIds(session, agentName) {
  const ownIds = new Set;
  for (const msg of session.messages ?? []) {
    const meta = msg.atoma_metadata;
    if (msg.role !== "assistant" || !meta || meta.github_comment_id === undefined)
      continue;
    if (meta.agent !== undefined && meta.agent !== agentName)
      continue;
    const id = normalizeId(meta.github_comment_id);
    if (id !== undefined)
      ownIds.add(id);
  }
  return ownIds;
}
function extractResultCommentAgent(event) {
  if (!event.author.endsWith("[bot]"))
    return;
  if (!event.content)
    return;
  const firstLine = event.content.split(`
`)[0].trim();
  return AGENT_TAG.read(firstLine);
}
function isSelfEvent(event, agentName, ownCommentIds) {
  const eventId = normalizeId(event.id);
  if (eventId !== undefined && ownCommentIds.has(eventId))
    return true;
  return extractResultCommentAgent(event) === agentName;
}
function contextPolicy(config, agentName) {
  const sharedContext = config.agents?.[agentName]?.shared_context;
  if (!sharedContext)
    return { exclude: new Set };
  return {
    include: sharedContext.include_event_types ? new Set(sharedContext.include_event_types) : undefined,
    exclude: new Set(sharedContext.exclude_event_types ?? [])
  };
}
function filterEventsForAgent(events, agentName, ownCommentIds, config) {
  const { include, exclude } = contextPolicy(config, agentName);
  const filtered = [];
  for (const event of events) {
    if (event.author.endsWith("[bot]") && LLM_CONTEXT_TAG.read(event.content) === "exclude") {
      console.error(`  Skipping operational notification from LLM context: id=${event.id}`);
      continue;
    }
    if (isSelfEvent(event, agentName, ownCommentIds)) {
      console.error(`  Skipping current agent comment from shared context: id=${event.id}`);
      continue;
    }
    if (include && !include.has(event.event_type))
      continue;
    if (exclude.has(event.event_type))
      continue;
    filtered.push(event);
  }
  return filtered;
}
function eventToUserMessage(event) {
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
      ...event.sha !== undefined ? { sha: event.sha } : {}
    }
  };
}
function canonicalStringify(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalStringify).join(",")}]`;
  const obj = value;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}
function snapshotHashForEvents(events) {
  return createHash("sha256").update(canonicalStringify(events)).digest("hex");
}
function previousSnapshotHash(session) {
  return session.metadata?.github_context?.snapshot_hash;
}
function reconcileGithubSession(session, events, agentName, config = {}) {
  const ownCommentIds = buildOwnCommentIds(session, agentName);
  const filteredEvents = filterEventsForAgent(events, agentName, ownCommentIds, config);
  const currentHash = snapshotHashForEvents(filteredEvents);
  const previousHash = previousSnapshotHash(session);
  const contextMessages = filteredEvents.map(eventToUserMessage);
  const fetchedEventKeys = new Set(events.map(githubEventKeyFromEvent));
  let changedCount;
  if (previousHash === currentHash)
    changedCount = 0;
  else if (previousHash === undefined)
    changedCount = filteredEvents.length;
  else
    changedCount = 1;
  const mergedSession = mergeGithubContext(session, contextMessages, fetchedEventKeys);
  mergedSession.metadata = {
    ...mergedSession.metadata,
    github_context: {
      ...mergedSession.metadata?.github_context,
      version: 1,
      snapshot_hash: currentHash,
      event_count: filteredEvents.length,
      agent: agentName
    }
  };
  return {
    mergedSession,
    changedCount,
    snapshotHash: currentHash,
    eventCount: filteredEvents.length
  };
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      events: { type: "string" },
      "agent-name": { type: "string" },
      config: { type: "string" },
      session: { type: "string" },
      out: { type: "string" }
    }
  });
  if (!values.events || !values["agent-name"] || !values.session || !values.out) {
    console.error("usage: reconcile_github_session.ts --events events.json --agent-name AGENT --session session.json [--config config.json] --out session.json");
    process.exit(2);
  }
  const session = existsSync(values.session) ? JSON.parse(readFileSync(values.session, "utf8")) : { messages: [] };
  const events = JSON.parse(readFileSync(values.events, "utf8"));
  const config = values.config && existsSync(values.config) ? JSON.parse(readFileSync(values.config, "utf8")) : {};
  const { mergedSession, changedCount, snapshotHash, eventCount } = reconcileGithubSession(session, events, values["agent-name"], config);
  writeFileSync(values.out, JSON.stringify(mergedSession, null, 2) + `
`);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `new_event_count=${changedCount}
context_snapshot_hash=${snapshotHash}
context_event_count=${eventCount}
`);
  }
  console.error(`Context build complete: ${events.length} events fetched, ${eventCount} shared messages, changed=${changedCount}`);
}
if (import.meta.main)
  main();
export {
  ref,
  reconcileGithubSession,
  mergeGithubContext
};

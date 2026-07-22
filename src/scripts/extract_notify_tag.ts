#!/usr/bin/env bun
/**
 * extract_notify_tag.ts — Extract the `<!-- atoma:notify=LOGIN -->` tag
 * (embedded by mcp/github.ts) directly from an already-fetched
 * PR body, if present. Unlike resolve_notify.ts (which calls the GitHub API
 * and walks up the parent-issue chain), this is a pure, offline string
 * parse -- used by workflow steps that already have the PR body as an event
 * property, with no fallback needed.
 *
 * Env: PR_BODY
 * Writes `notify=<login-or-empty>` to $GITHUB_OUTPUT.
 */
import { appendFileSync } from "node:fs";

const NOTIFY_RE = /<!--\s*atoma:notify=([A-Za-z0-9-]+)\s*-->/;

function main(): void {
  const body = process.env.PR_BODY ?? "";
  const notify = NOTIFY_RE.exec(body)?.[1] ?? "";
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `notify=${notify}\n`);
}

if (import.meta.main) main();

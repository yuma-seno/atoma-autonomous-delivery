#!/usr/bin/env bun
/**
 * fetch_events.ts — Fetch all GitHub events for an Issue or PR as a JSON
 * array (sorted by created_at), written to --out.
 *
 * Each event has: {id, event_type, content, author, created_at, sha?}
 *
 * Event types:
 *   issue_opened           — Issue body
 *   issue_comment          — Issue comment
 *   pr_opened               — PR body
 *   pr_diff                 — PR current diff (stable ID: "pr-{number}-diff")
 *   pr_comment               — PR conversation comment
 *   pr_review                — PR review submission (state + body)
 *   pr_review_comment        — PR inline review comment
 *
 * Usage:
 *   fetch_events.ts --type issue|pr --number N [--max-diff-chars N] --out events.json
 *
 * Requires GITHUB_REPOSITORY (owner/repo) in the environment.
 * Writes `resolved_type` / `resolved_number` to $GITHUB_OUTPUT. A PR linked
 * via `<!-- atoma:parent-issue=N -->` resolves to that canonical Issue so
 * Issue and PR runs share one serial conversation/session.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gh, ghJson, ghPaginated } from "../lib/gh.ts";
import { PARENT_ISSUE_TAG } from "../lib/tags.ts";
import { defineScript } from "./lib/script-ref.ts";

export interface FetchEventsArgs {
  type: string;
  number: string | number;
  "max-diff-chars"?: string | number;
  out: string;
}

export const ref = defineScript<FetchEventsArgs>(import.meta.url);

export interface GithubEvent {
  id: string | number;
  event_type: string;
  content: string;
  author: string;
  created_at: string;
  sha?: string;
}

interface GhIssueApi {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  user: { login: string };
  created_at: string;
}

interface GhCommentApi {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
}

interface GhPrApi {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  created_at: string;
  updated_at: string;
  labels: { name: string }[];
  head: { sha: string };
}

interface GhReviewApi {
  id: number;
  body: string | null;
  state: string;
  user: { login: string };
  submitted_at: string | null;
}

interface GhReviewCommentApi {
  id: number;
  path: string;
  line: number | null;
  original_line: number | null;
  body: string;
  user: { login: string };
  created_at: string;
}

export interface FetchEventsResult {
  events: GithubEvent[];
  resolvedType: "issue" | "pr";
  resolvedNumber: number;
}

function repoParts(): [string, string] {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const [owner, name] = repo.split("/", 2);
  if (!owner || !name) throw new Error(`GITHUB_REPOSITORY is not set or malformed: "${repo}"`);
  return [owner, name];
}

function fetchIssueEvents(
  owner: string,
  repo: string,
  issueNum: number,
  openedType: string,
  commentType: string,
  idPrefix: string,
): GithubEvent[] {
  const issue = JSON.parse(gh("api", `repos/${owner}/${repo}/issues/${issueNum}`).stdout) as GhIssueApi;

  const labelsLine = issue.labels.length > 0 ? `**Labels:** ${issue.labels.map((l) => l.name).join(", ")}\n` : "";
  const openedEvent: GithubEvent = {
    id: `${idPrefix}-${issue.number}`,
    event_type: openedType,
    content: `Issue #${issue.number}: ${issue.title}\n${labelsLine}\n${issue.body ?? ""}`,
    author: issue.user.login,
    created_at: issue.created_at,
  };

  const comments = ghPaginated<GhCommentApi>("api", `repos/${owner}/${repo}/issues/${issueNum}/comments`);
  const commentEvents: GithubEvent[] = comments.map((c) => ({
    id: c.id,
    event_type: commentType,
    content: c.body,
    author: c.user.login,
    created_at: c.created_at,
  }));

  return [openedEvent, ...commentEvents];
}

function fetchPrEvents(owner: string, repo: string, number: number, maxDiffChars: number): { events: GithubEvent[]; parentIssue?: number } {
  const pr = JSON.parse(gh("api", `repos/${owner}/${repo}/pulls/${number}`).stdout) as GhPrApi;
  const prBody = pr.body ?? "";
  const parentIssue = PARENT_ISSUE_TAG.read(prBody);
  const headSha = pr.head.sha.slice(0, 8);
  const events: GithubEvent[] = [];

  const labelsLine = pr.labels.length > 0 ? `**Labels:** ${pr.labels.map((label) => label.name).join(", ")}` : "";
  const linkedLine = parentIssue ? `**Linked Issue:** #${parentIssue}` : "";
  const prContentLines = [`PR #${number}: ${pr.title}`, labelsLine, linkedLine].filter(Boolean);
  prContentLines.push("", prBody);
  events.push({
    id: `pr-${number}`,
    event_type: "pr_opened",
    content: prContentLines.join("\n"),
    author: pr.user.login,
    created_at: pr.created_at,
  });

  const diffResult = gh("api", `repos/${owner}/${repo}/pulls/${number}`, "-H", "Accept: application/vnd.github.v3.diff");
  const diff = diffResult.code === 0 ? diffResult.stdout : "";
  if (diff) {
    const truncated = diff.slice(0, maxDiffChars);
    let diffContent = "```diff\n" + truncated + "\n```";
    if (diff.length > maxDiffChars) diffContent += `\n\n*[Diff truncated at ${maxDiffChars} characters due to size]*`;
    events.push({
      id: `pr-${number}-diff`,
      event_type: "pr_diff",
      content: diffContent,
      sha: headSha,
      author: "github",
      created_at: pr.updated_at,
    });
  }

  const prComments = ghPaginated<GhCommentApi>("api", `repos/${owner}/${repo}/issues/${number}/comments`);
  events.push(...prComments.map((comment) => ({
    id: comment.id,
    event_type: "pr_comment",
    content: comment.body,
    author: comment.user.login,
    created_at: comment.created_at,
  })));

  const reviews = ghPaginated<GhReviewApi>("api", `repos/${owner}/${repo}/pulls/${number}/reviews`);
  events.push(...reviews.filter((review) => review.submitted_at != null).map((review) => ({
    id: `pr-review-${review.id}`,
    event_type: "pr_review",
    content: `Review state: ${review.state}\n\n${review.body ?? ""}`,
    author: review.user.login,
    created_at: review.submitted_at!,
  })));

  const inlineComments = ghPaginated<GhReviewCommentApi>("api", `repos/${owner}/${repo}/pulls/${number}/comments`);
  events.push(...inlineComments.map((comment) => ({
    id: comment.id,
    event_type: "pr_review_comment",
    content: `On \`${comment.path}\` line ${comment.line ?? comment.original_line ?? "?"}:\n\n${comment.body}`,
    author: comment.user.login,
    created_at: comment.created_at,
  })));

  return { events, parentIssue };
}

function linkedPrNumbers(owner: string, repo: string, issueNumber: number): number[] {
  const prs = ghJson<{ number: number }[]>(
    "pr", "list", "--repo", `${owner}/${repo}`, "--state", "all",
    "--search", `atoma:parent-issue=${issueNumber} in:body`,
    "--limit", "1000", "--json", "number",
  ) ?? [];
  if (prs.length === 1000) {
    console.error(`::warning::Linked PR search for Issue #${issueNumber} reached GitHub's 1000-result search limit.`);
  }
  return prs.map((pr) => pr.number);
}

function tryLinkedPrNumbers(owner: string, repo: string, issueNumber: number): number[] {
  try {
    return linkedPrNumbers(owner, repo, issueNumber);
  } catch {
    console.error(`::warning::Could not search linked PRs for Issue #${issueNumber}; using the available context.`);
    return [];
  }
}

function appendPrEvents(
  events: GithubEvent[],
  owner: string,
  repo: string,
  prNumber: number,
  maxDiffChars: number,
): void {
  try {
    events.push(...fetchPrEvents(owner, repo, prNumber, maxDiffChars).events);
  } catch {
    console.error(`::warning::Could not fetch linked PR #${prNumber}; skipping it.`);
  }
}

export function fetchEvents(
  type: "issue" | "pr",
  number: number,
  maxDiffChars: number,
): FetchEventsResult {
  const [owner, repo] = repoParts();

  if (type === "issue") {
    const events = fetchIssueEvents(owner, repo, number, "issue_opened", "issue_comment", "issue");
    for (const prNumber of tryLinkedPrNumbers(owner, repo, number)) {
      appendPrEvents(events, owner, repo, prNumber, maxDiffChars);
    }
    events.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { events, resolvedType: "issue", resolvedNumber: number };
  }

  const prResult = fetchPrEvents(owner, repo, number, maxDiffChars);
  let events = [...prResult.events];
  if (prResult.parentIssue) {
    try {
      events = fetchIssueEvents(owner, repo, prResult.parentIssue, "issue_opened", "issue_comment", "issue");
      const relatedPrNumbers = new Set([number, ...tryLinkedPrNumbers(owner, repo, prResult.parentIssue)]);
      for (const relatedPrNumber of relatedPrNumbers) {
        if (relatedPrNumber === number) events.push(...prResult.events);
        else appendPrEvents(events, owner, repo, relatedPrNumber, maxDiffChars);
      }
    } catch {
      console.error(`::warning::Linked Issue #${prResult.parentIssue} not found or inaccessible — using PR-local context.`);
      events.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { events, resolvedType: "pr", resolvedNumber: number };
    }
  }

  events.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    events,
    resolvedType: prResult.parentIssue ? "issue" : "pr",
    resolvedNumber: prResult.parentIssue ?? number,
  };
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: "string" },
      number: { type: "string" },
      "max-diff-chars": { type: "string" },
      out: { type: "string" },
    },
  });

  if ((values.type !== "issue" && values.type !== "pr") || !values.number || !values.out) {
    console.error("usage: fetch_events.ts --type issue|pr --number N [--max-diff-chars N] --out events.json");
    process.exit(2);
  }

  const maxDiffChars = Number(values["max-diff-chars"] ?? 30000);
  const { events, resolvedType, resolvedNumber } = fetchEvents(values.type, Number(values.number), maxDiffChars);

  writeFileSync(values.out, JSON.stringify(events, null, 2));

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `resolved_type=${resolvedType}\nresolved_number=${resolvedNumber}\n`);

  console.error(`Fetched ${events.length} events → ${values.out}`);
}

if (import.meta.main) main();

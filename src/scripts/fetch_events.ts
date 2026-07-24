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
 *   linked_issue_opened      — Linked Issue body (from PR)
 *   linked_issue_comment     — Linked Issue comment (from PR)
 *
 * Usage:
 *   fetch_events.ts --type issue|pr --number N [--max-diff-chars N] --out events.json
 *
 * Requires GITHUB_REPOSITORY (owner/repo) in the environment.
 * Writes `resolved_number` to $GITHUB_OUTPUT: for PRs with a linked Issue
 * (detected via `<!-- atoma-linked-issue: N -->` in the PR body), this is
 * the linked Issue number; otherwise the same as --number.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gh, ghPaginated } from "../lib/gh.ts";
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

export function fetchEvents(
  type: "issue" | "pr",
  number: number,
  maxDiffChars: number,
): { events: GithubEvent[]; resolvedNumber: number } {
  const [owner, repo] = repoParts();

  if (type === "issue") {
    const events = fetchIssueEvents(owner, repo, number, "issue_opened", "issue_comment", "issue");
    events.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { events, resolvedNumber: number };
  }

  const pr = JSON.parse(gh("api", `repos/${owner}/${repo}/pulls/${number}`).stdout) as GhPrApi;
  const prBody = pr.body ?? "";
  const headSha = pr.head.sha.slice(0, 8);

  const linkedMatch = /<!--\s*atoma-linked-issue:\s*(\d+)\s*-->/.exec(prBody);
  let linkedIssue = linkedMatch ? Number(linkedMatch[1]) : undefined;
  let resolvedNumber = linkedIssue ?? number;

  const events: GithubEvent[] = [];

  if (linkedIssue) {
    try {
      events.push(
        ...fetchIssueEvents(owner, repo, linkedIssue, "linked_issue_opened", "linked_issue_comment", "linked-issue"),
      );
    } catch {
      console.error(`::warning::Linked Issue #${linkedIssue} not found or inaccessible — skipping.`);
      // Keep resolvedNumber as the PR number if the linked issue is inaccessible.
      linkedIssue = undefined;
      resolvedNumber = number;
    }
  }

  const labelsLine = pr.labels.length > 0 ? `**Labels:** ${pr.labels.map((l) => l.name).join(", ")}` : "";
  const linkedLine = linkedIssue ? `**Linked Issue:** #${linkedIssue}` : "";
  const prContentLines = [`PR #${number}: ${pr.title}`, labelsLine, linkedLine].filter(Boolean);
  prContentLines.push("", prBody);
  events.push({
    id: `pr-${number}`,
    event_type: "pr_opened",
    content: prContentLines.join("\n"),
    author: pr.user.login,
    created_at: pr.created_at,
  });

  // Stable ID (no SHA) -- updated in-place on each push. created_at =
  // PR updated_at so it sorts after the PR body but before post-push comments.
  const diffResult = gh("api", `repos/${owner}/${repo}/pulls/${number}`, "-H", "Accept: application/vnd.github.v3.diff");
  const diff = diffResult.code === 0 ? diffResult.stdout : "";
  if (diff) {
    const truncated = diff.slice(0, maxDiffChars);
    let diffContent = "```diff\n" + truncated + "\n```";
    if (diff.length > maxDiffChars) {
      diffContent += `\n\n*[Diff truncated at ${maxDiffChars} characters due to size]*`;
    }
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
  events.push(
    ...prComments.map((c) => ({
      id: c.id,
      event_type: "pr_comment",
      content: c.body,
      author: c.user.login,
      created_at: c.created_at,
    })),
  );

  const reviews = ghPaginated<GhReviewApi>("api", `repos/${owner}/${repo}/pulls/${number}/reviews`);
  events.push(
    ...reviews
      .filter((r) => r.submitted_at != null)
      .map((r) => ({
        id: `pr-review-${r.id}`,
        event_type: "pr_review",
        content: `Review state: ${r.state}\n\n${r.body ?? ""}`,
        author: r.user.login,
        created_at: r.submitted_at!,
      })),
  );

  const inlineComments = ghPaginated<GhReviewCommentApi>("api", `repos/${owner}/${repo}/pulls/${number}/comments`);
  events.push(
    ...inlineComments.map((c) => ({
      id: c.id,
      event_type: "pr_review_comment",
      content: `On \`${c.path}\` line ${c.line ?? c.original_line ?? "?"}:\n\n${c.body}`,
      author: c.user.login,
      created_at: c.created_at,
    })),
  );

  events.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { events, resolvedNumber };
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
  const { events, resolvedNumber } = fetchEvents(values.type, Number(values.number), maxDiffChars);

  writeFileSync(values.out, JSON.stringify(events, null, 2));

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `resolved_number=${resolvedNumber}\n`);

  console.error(`Fetched ${events.length} events → ${values.out}`);
}

if (import.meta.main) main();

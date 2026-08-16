/**
 * issue-index.ts — keeps the searchable copy of this repository's issues.
 *
 * The index is a cache, not a source of truth: everything in it came from
 * GitHub and can be fetched again. What makes it worth keeping is that
 * rebuilding it from nothing costs one request per hundred issues plus one per
 * hundred comments, and a repository that has been running for a while has
 * thousands of both.
 *
 * Refreshing is cheap because GitHub answers the only question that matters.
 * `?since=<timestamp>` returns just what changed, on both the issue list and
 * the comment list, so an index that is already current costs two requests to
 * confirm. There is no separate refresh workflow, no schedule, and no
 * invalidation logic — the search catches itself up when it is called, or it
 * does nothing.
 */
import { gh } from "./gh.ts";
import { buildIndex, splitBody, type Bm25Index, type Chunk } from "../domain/bm25.ts";

/** Where the index lives on the `atoma-data` branch. */
export const INDEX_PATH = "search/issue-index.json";

/** Everything needed to search, and to know what to fetch next time. */
export interface IssueIndex {
  version: 1;
  /** The newest `updated_at` seen, and the `since` for the next refresh. */
  updatedThrough: string;
  issues: IndexedIssue[];
  /** Built from `issues`; stored so a search does not pay to rebuild it. */
  bm25?: Bm25Index;
  chunks?: Chunk[];
}

export interface IndexedIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  updatedAt: string;
  comments: string[];
}

interface ApiIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  updated_at: string;
  pull_request?: unknown;
}

interface ApiComment {
  issue_url: string;
  body: string | null;
  updated_at: string;
}

function log(message: string): void {
  console.error(`[atoma-search] ${message}`);
}

/** Longest issue body kept. Beyond this an issue is a document, not a discussion. */
const MAX_BODY = 6000;
const MAX_COMMENT = 3000;
const MAX_COMMENTS_PER_ISSUE = 40;

function ghJsonPaged<T>(path: string): T[] {
  const { code, stdout, stderr } = gh("api", "--paginate", path);
  if (code !== 0) {
    log(`WARN could not read ${path}: ${stderr || stdout}`);
    return [];
  }
  // `--paginate` concatenates one JSON document per page, so the pages are
  // parsed individually rather than as one array.
  const documents = stdout.replace(/\]\s*\[/g, "],[");
  try {
    return JSON.parse(`[${documents}]`).flat() as T[];
  } catch {
    try {
      return JSON.parse(stdout) as T[];
    } catch {
      log(`WARN ${path} was not valid JSON`);
      return [];
    }
  }
}

/**
 * Fetch issues and their comments, optionally only what changed.
 *
 * Pull requests are excluded. GitHub returns them from the issues endpoint and
 * they are real work with real discussion, but their bodies are largely
 * generated summaries of the issue they close — indexing both puts two entries
 * in front of a reader for one piece of work.
 */
export function fetchIssues(repo: string, since?: string): IndexedIssue[] {
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
  const raw = ghJsonPaged<ApiIssue>(`repos/${repo}/issues?state=all&per_page=100${sinceParam}`);
  const issues = raw.filter((issue) => issue.pull_request === undefined);
  if (issues.length === 0) return [];

  const comments = ghJsonPaged<ApiComment>(`repos/${repo}/issues/comments?per_page=100${sinceParam}`);
  const byIssue = new Map<number, string[]>();
  for (const comment of comments) {
    const number = Number(comment.issue_url.split("/").pop());
    if (!Number.isInteger(number) || !comment.body) continue;
    const list = byIssue.get(number) ?? [];
    if (list.length < MAX_COMMENTS_PER_ISSUE) list.push(comment.body.slice(0, MAX_COMMENT));
    byIssue.set(number, list);
  }

  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: (issue.body ?? "").slice(0, MAX_BODY),
    state: issue.state,
    updatedAt: issue.updated_at,
    comments: byIssue.get(issue.number) ?? [],
  }));
}

/**
 * Merge freshly fetched issues over the stored ones.
 *
 * An issue that changed replaces its old entry outright rather than merging
 * field by field, because a partial refresh would leave an edited body beside
 * comments fetched at a different time.
 *
 * A refresh returns an issue's comments only when a comment changed, so an
 * issue whose body was edited comes back with none. Those keep the comments
 * already stored.
 */
export function mergeIssues(stored: IndexedIssue[], fresh: IndexedIssue[]): IndexedIssue[] {
  const byNumber = new Map(stored.map((issue) => [issue.number, issue]));
  for (const issue of fresh) {
    const previous = byNumber.get(issue.number);
    byNumber.set(issue.number, {
      ...issue,
      comments: issue.comments.length > 0 ? issue.comments : (previous?.comments ?? []),
    });
  }
  return [...byNumber.values()].sort((a, b) => b.number - a.number);
}

/** The passages to search: the title alone, each section of the body, each comment. */
export function chunksFor(issues: IndexedIssue[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const issue of issues) {
    chunks.push({ issue: issue.number, text: issue.title });
    for (const part of splitBody(issue.body)) {
      chunks.push({ issue: issue.number, text: `${issue.title}\n${part}` });
    }
    for (const comment of issue.comments) {
      for (const part of splitBody(comment)) {
        chunks.push({ issue: issue.number, text: `${issue.title}\n${part}` });
      }
    }
  }
  return chunks;
}

/** The newest `updated_at` across the set, which becomes the next `since`. */
export function newestTimestamp(issues: IndexedIssue[], fallback: string): string {
  let newest = fallback;
  for (const issue of issues) if (issue.updatedAt > newest) newest = issue.updatedAt;
  return newest;
}

/** Rebuild the derived parts after the issue set changes. */
export function withDerived(index: Omit<IssueIndex, "bm25" | "chunks">): IssueIndex {
  const chunks = chunksFor(index.issues);
  return { ...index, chunks, bm25: buildIndex(chunks.map((chunk) => chunk.text)) };
}

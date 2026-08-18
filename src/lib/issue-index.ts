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
import { ghPaginated } from "./gh.ts";
import { buildIndex, splitBody, type Bm25Index, type Chunk } from "../domain/bm25.ts";

/** Where the index lives on the `atoma-data` branch. */
export const INDEX_PATH = "search/issue-index.json";

/**
 * Everything needed to search, and to know what to fetch next time.
 *
 * `version` is a format stamp, not a migration target: a stored index whose
 * version does not match is discarded and rebuilt, which costs the seconds a
 * full build costs and never leaves a half-converted index behind. Version 2
 * added the source tag on every chunk and fixed the comment loss described on
 * `fetchIssues`, so a version 1 index has comments missing from it and no way
 * to say which comment a passage came from.
 */
export const INDEX_VERSION = 2;

export interface IssueIndex {
  version: number;
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

/**
 * `gh api --paginate`, with this module's own policy for a failure: log it and
 * index nothing, rather than stopping the run.
 *
 * The paging itself is `ghPaginated`, not a second implementation. This used to
 * split the concatenated per-page documents with
 * `stdout.replace(/\]\s*\[/g, "],[")`, which is not string-aware — a body or a
 * comment containing the literal characters `] [`, which a Markdown line like
 * `[draft] [blocked]` is enough to produce, was rewritten *inside* the JSON
 * string and silently went into the search index corrupted. `gh.ts` already owns
 * this problem and solves it with a scanner that tracks quoting and escapes.
 *
 * Only the error policy is local, and only the error policy should be.
 */
function ghJsonPaged<T>(path: string): T[] {
  try {
    return ghPaginated<T>("api", path);
  } catch (error) {
    log(`WARN could not read ${path}: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Fetch issues and their comments, optionally only what changed.
 *
 * Pull requests are excluded. GitHub returns them from the issues endpoint and
 * they are real work with real discussion, but their bodies are largely
 * generated summaries of the issue they close — indexing both puts two entries
 * in front of a reader for one piece of work.
 *
 * The comments are read two different ways on purpose, because the endpoint
 * that is right for a full build is wrong for a refresh. `/issues/comments`
 * returns every comment in the repository in one paginated sweep, which is the
 * only affordable way to build from nothing; but with `?since=` it returns just
 * the comments that changed, and an issue that gained its fifth comment comes
 * back holding only that one. Storing that as the issue's comments deletes the
 * other four — silently, and a little more on every refresh. So a refresh
 * re-reads the whole conversation of each issue it touches, one request each.
 * Deltas are a handful of issues, and this is the difference between comment
 * positions that mean something and an index that decays.
 */
export function fetchIssues(repo: string, since?: string): IndexedIssue[] {
  const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
  const raw = ghJsonPaged<ApiIssue>(`repos/${repo}/issues?state=all&per_page=100${sinceParam}`);
  const issues = raw.filter((issue) => issue.pull_request === undefined);
  if (issues.length === 0) return [];

  const byIssue = since
    ? new Map(issues.map((issue) => [issue.number, commentsOf(repo, issue.number)]))
    : allComments(repo);

  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: (issue.body ?? "").slice(0, MAX_BODY),
    state: issue.state,
    updatedAt: issue.updated_at,
    comments: byIssue.get(issue.number) ?? [],
  }));
}

/** Every comment in the repository, grouped by issue. One sweep, for a full build. */
function allComments(repo: string): Map<number, string[]> {
  const comments = ghJsonPaged<ApiComment>(`repos/${repo}/issues/comments?per_page=100`);
  const byIssue = new Map<number, string[]>();
  for (const comment of comments) {
    const number = Number(comment.issue_url.split("/").pop());
    if (!Number.isInteger(number) || !comment.body) continue;
    const list = byIssue.get(number) ?? [];
    if (list.length < MAX_COMMENTS_PER_ISSUE) list.push(comment.body.slice(0, MAX_COMMENT));
    byIssue.set(number, list);
  }
  return byIssue;
}

/** One issue's whole conversation, in GitHub's order, for a refresh. */
function commentsOf(repo: string, issue: number): string[] {
  return ghJsonPaged<ApiComment>(`repos/${repo}/issues/${issue}/comments?per_page=100`)
    .filter((comment) => comment.body)
    .slice(0, MAX_COMMENTS_PER_ISSUE)
    .map((comment) => (comment.body ?? "").slice(0, MAX_COMMENT));
}

/**
 * Merge freshly fetched issues over the stored ones.
 *
 * An issue that changed replaces its old entry outright rather than merging
 * field by field, because a partial refresh would leave an edited body beside
 * comments fetched at a different time.
 *
 * That includes the comments, which `fetchIssues` now reads in full for every
 * issue it returns. An empty list means the conversation is empty — a comment
 * was deleted, or there never was one — and keeping the stored comments to
 * avoid "losing" them would preserve exactly the entries GitHub says are gone.
 */
export function mergeIssues(stored: IndexedIssue[], fresh: IndexedIssue[]): IndexedIssue[] {
  const byNumber = new Map(stored.map((issue) => [issue.number, issue]));
  for (const issue of fresh) byNumber.set(issue.number, issue);
  return [...byNumber.values()].sort((a, b) => b.number - a.number);
}

/**
 * The passages to search: the title alone, each section of the body, each
 * section of each comment — every one tagged with where it came from.
 *
 * `text` is the passage by itself. The title is prepended only when the passage
 * becomes a BM25 document (see `withDerived`), because a passage that repeats
 * its own title back to the reader wastes the excerpt it is shown in, while a
 * document that omits it loses the words the issue is about.
 */
function chunksFor(issues: IndexedIssue[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const issue of issues) {
    chunks.push({ issue: issue.number, source: "title", text: issue.title });
    for (const part of splitBody(issue.body)) {
      chunks.push({ issue: issue.number, source: "body", text: part });
    }
    issue.comments.forEach((comment, i) => {
      for (const part of splitBody(comment)) {
        chunks.push({ issue: issue.number, source: i + 1, text: part });
      }
    });
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
  const titles = new Map(index.issues.map((issue) => [issue.number, issue.title]));
  const documents = chunks.map((chunk) =>
    chunk.source === "title" ? chunk.text : `${titles.get(chunk.issue) ?? ""}\n${chunk.text}`,
  );
  return { ...index, chunks, bm25: buildIndex(documents) };
}

#!/usr/bin/env bun
/**
 * search.ts — finds the issues that answer a question.
 *
 * Two stages, and the division of labour matters. BM25 casts a net over every
 * passage of every issue and comment; a cross encoder then reads the twenty
 * issues it caught and decides which of them actually answers what was asked.
 * The first stage is not semantic and does not need to be — its only job is to
 * avoid losing the answer before the second stage sees it.
 *
 * Measured over this repository, 181 issues and 22 questions phrased the way an
 * agent phrases them:
 *
 *   BM25 alone, recall@20 ......... 100%
 *   plus the cross encoder, top 1 .. 91%, top 3 100%
 *
 * A dense vector index alongside BM25 changed the final ranking on none of the
 * 22, which is why there is no embedding model here, no vector store, and
 * nothing to re-embed when an issue is edited. Enlarging the embedding model
 * 16-fold changed nothing either; enlarging the reranker moved top 1 from 27%
 * to 91%. The whole budget belongs to the second stage.
 *
 * Ask it a question, not a keyword. Phrasing the query as a sentence rather
 * than a title was worth more than every other change combined — recall at 5
 * went from 48% to 95% on the same index with the same models. Which is why the
 * tool description spends its length on how to phrase the question: the caller
 * writes the query, so the caller holds the largest lever on the result.
 *
 * The same reasoning makes the language of the query part of the contract. The
 * first stage matches character bigrams and nothing else, so a question asked
 * in a language the issues are not written in shares no bigrams with them and
 * scores near zero — the answer never reaches the cross encoder, which is
 * multilingual and would have recognised it. An agent reads English
 * instructions while this repository's issues are Japanese, so this is a live
 * hazard rather than a theoretical one, and the description says so outright.
 */
import { AutoTokenizer, AutoModelForSequenceClassification, env as transformersEnv } from "@huggingface/transformers";
import { buildMcpTools, defineMcpTool, positiveInt, serveMcpServer, z } from "../../../../lib/mcp-tool.ts";
import { rankIssues, score, type Bm25Index, type Chunk } from "../../../../domain/bm25.ts";
import { getRerankerModel } from "../../../../lib/config.ts";
import {
  INDEX_PATH,
  INDEX_VERSION,
  fetchIssues,
  mergeIssues,
  newestTimestamp,
  withDerived,
  type IndexedIssue,
  type IssueIndex,
} from "../../../../lib/issue-index.ts";
// Named for sessions because that is what the branch was built to hold, but
// both take a path and content and care about neither. The index is stored the
// same way for the same reason: a runner has no other durable storage between
// runs, and the push-retry loop already handles the races that sibling agents
// cause.
import { restoreSession as restoreFile, saveSession as saveFile } from "../../../../scripts/lib/atoma-data.ts";
import { hardenCredentialHolder } from "../lib/harden.ts";

const REPO = process.env.GITHUB_REPOSITORY ?? "";

/** How many issues the cross encoder reads. Twenty held every answer in measurement. */
const CANDIDATES = 20;

/** How much of an issue the cross encoder is shown. Beyond this its input truncates anyway. */
const DOCUMENT_BUDGET = 1800;

/**
 * How much of the matched passage the caller is shown.
 *
 * Enough to tell whether it is worth opening, not enough to be a substitute for
 * opening it. The excerpt's job is to carry the reader to
 * `github__get_issue_comments`, not to replace it.
 */
const EXCERPT_BUDGET = 700;

const SEARCH_SCHEMA = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      [
        "A whole question, in the language the issues are written in.",
        "",
        "Phrasing is the single biggest factor in whether the right issue comes back — a question found the answer twice as often as the keywords from the same question. Ask what you actually want to know, in one sentence, including the words you would use when explaining it to a person:",
        "",
        "  good: why does a branch get created at the first commit rather than up front",
        "  poor: branch creation",
        "",
        "  good: is it already known that the reviewer cannot approve its own pull request",
        "  poor: reviewer approve",
        "",
        "  good: has anyone tried using an embedding model for this search before",
        "  poor: embedding",
        "",
        "Write it in the language this repository's issues are written in, which is the language of the issue in front of you — not necessarily the language you are being instructed in. The first stage matches characters rather than meaning, so a question in the wrong language finds nothing at all.",
      ].join("\n"),
    ),
  limit: positiveInt(
    "How many issues to return. Defaults to 3, which held the answer for every question measured. " +
      "At most 20: the ranking pipeline considers that many candidates, so a larger number returns 20.",
  )
    .max(CANDIDATES)
    .optional(),
});

function log(message: string): void {
  console.error(`[atoma-search] ${message}`);
}

// Same OS user as every other tool server, including the one that runs arbitrary
// commands -- so this process makes itself unreadable to its peers and drops
// writable directories from its PATH. See `../lib/harden.ts` for what that closes,
// what it costs, and what it deliberately leaves open.
hardenCredentialHolder(log);

/**
 * The issue this run is working on, which is never a useful search result.
 *
 * Its whole text is already in the prompt, so returning it spends a slot on
 * something the reader has in front of them. That would be a small waste if it
 * were occasional; measured, it took first place on all six searches of a run,
 * because the issue holding the question is by construction the best match for
 * that question. This is not something ranking can fix — the passage genuinely
 * is the most relevant one, and the cross encoder agreed with BM25 about it
 * every time. What disqualifies it is identity, not relevance, so it is removed
 * by identity.
 */
function currentIssue(): number | undefined {
  const parsed = Number((process.env.ISSUE_NUMBER ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The index, brought up to date.
 *
 * A stored index is refreshed with `?since=`, so an index that is already
 * current costs two requests. With nothing stored, everything is fetched — one
 * request per hundred issues and per hundred comments — and that is the only
 * time this is slow.
 */
function loadIndex(): IssueIndex {
  const stored = restoreFile(INDEX_PATH);
  let previous: IssueIndex | undefined;
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as IssueIndex;
      if (parsed.version === INDEX_VERSION) previous = parsed;
      else log(`index format ${parsed.version} is not ${INDEX_VERSION}; rebuilding it`);
    } catch {
      log("WARN the stored index was not valid JSON; rebuilding it");
    }
  }

  const since = previous?.updatedThrough;
  const fresh = fetchIssues(REPO, since);
  if (previous && fresh.length === 0) {
    log(`index current: ${previous.issues.length} issues, nothing changed since ${since}`);
    return previous.bm25 && previous.chunks ? previous : withDerived(previous);
  }

  const issues = mergeIssues(previous?.issues ?? [], fresh);
  log(`index: ${issues.length} issues (${fresh.length} fetched${since ? ` since ${since}` : " — full build"})`);

  const index = withDerived({
    version: INDEX_VERSION,
    updatedThrough: newestTimestamp(fresh, since ?? "1970-01-01T00:00:00Z"),
    issues,
  });

  // Saving is best-effort. A failure costs the next search a full fetch; it
  // must not cost this one its answer.
  if (!saveFile(INDEX_PATH, JSON.stringify(index), `atoma: refresh issue search index (${issues.length} issues)`)) {
    log("WARN could not save the index; the next search will rebuild it");
  }
  return index;
}

type Reranker = { score(query: string, documents: string[]): Promise<number[]> };

/**
 * The load, started once and awaited by everyone who needs it.
 *
 * A promise rather than the resolved value, and this is the whole fix. The
 * reranker is a 544MB ONNX file, downloaded on every run -- the cache lives under
 * RUNNER_TEMP, which a job does not keep -- and it took 63.9 seconds, measured.
 * atoma gave up on the call at 60.0s, so the first search of every run failed,
 * and the answer arrived fifteen seconds after nobody was waiting for it.
 *
 * Holding the resolved value meant the load could only begin when a search asked
 * for it, and the whole 63.9s landed inside that one request. Holding the promise
 * means it can begin at startup instead -- see `main` at the bottom of this file.
 * In the run that measured this there were 47 seconds between the server
 * connecting and the first search arriving, so most of the load fits in time
 * nobody was using.
 *
 * It also makes two concurrent first searches share one load rather than starting
 * two, which the resolved-value form did not.
 */
let loading: Promise<Reranker> | undefined;

function loadReranker(): Promise<Reranker> {
  if (loading) return loading;
  loading = loadRerankerOnce();
  // A failed load must not be remembered as a failure forever: the next search
  // should be allowed to try again, since a download can fail for reasons that do
  // not repeat. Reranking already falls back to the first-stage order, which put
  // the answer in the top twenty on every one of the 22 measured questions.
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

/**
 * Where the model weights are cached.
 *
 * transformers.js defaults to a `.cache` directory INSIDE its own package, under
 * `node_modules`. That worked only by accident: `node_modules` happened to sit in
 * the work tree, which the tool user could write.
 *
 * It cannot now, and the failure was quiet -- the load reported
 *
 *   EACCES: permission denied, mkdir '.../node_modules/@huggingface/transformers/.cache'
 *
 * and fell back to the first-stage BM25 order. Every search still answered, and
 * answered worse, for as long as nobody read the log.
 *
 * Loosening the permission was the wrong fix. A library the servers import is not
 * theirs to write, and a package directory is not a cache directory -- it is
 * reinstalled, and on a fresh runner it is empty anyway, so caching there buys
 * nothing even when it is allowed. `XDG_CACHE_HOME` is where a cache goes, and the
 * runner already points it somewhere this user owns.
 *
 * Falls back to `/tmp` rather than leaving the default in place, because the
 * default is a path that is now guaranteed to fail.
 */
function cacheDirectory(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || "/tmp";
  return `${base}/atoma-transformers`;
}

async function loadRerankerOnce(): Promise<Reranker> {
  transformersEnv.cacheDir = cacheDirectory();
  log(`model cache: ${transformersEnv.cacheDir}`);
  const model = getRerankerModel();
  const started = Date.now();
  const tokenizer = await AutoTokenizer.from_pretrained(model);
  const cross = await AutoModelForSequenceClassification.from_pretrained(model, { dtype: "q8" });
  log(`reranker ${model} loaded in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  return {
    async score(query: string, documents: string[]): Promise<number[]> {
      const scores: number[] = [];
      for (let i = 0; i < documents.length; i += 8) {
        const batch = documents.slice(i, i + 8);
        const inputs = tokenizer(batch.map(() => query), {
          text_pair: batch,
          padding: true,
          truncation: true,
          max_length: 512,
        });
        const { logits } = await cross(inputs);
        scores.push(...(logits.tolist() as number[][]).map((row) => row[0] ?? 0));
      }
      return scores;
    },
  };
}

/**
 * What the cross encoder reads about a candidate.
 *
 * The passage that matched, under the issue's title, and then as much of the
 * body as the budget still allows. The order is the point: the encoder truncates
 * at its own token limit, so whatever is first is what it actually judges. Handing
 * it the head of the issue instead — which is what this did — means a decision
 * argued in the eighth comment is ranked on the strength of the opening
 * paragraph, and a long issue is judged on words nobody matched.
 *
 * The title always survives, because a passage alone often does not say what it
 * is about. The body tail is context, and is the first thing to go.
 */
function documentFor(issue: IndexedIssue, passage: string): string {
  const head = `${issue.title}\n${passage}`.slice(0, DOCUMENT_BUDGET);
  const remaining = DOCUMENT_BUDGET - head.length;
  return remaining > 200 ? `${head}\n${issue.body.slice(0, remaining)}` : head;
}

async function searchIssues(a: z.infer<typeof SEARCH_SCHEMA>): Promise<string> {
  if (!REPO) return "GITHUB_REPOSITORY is unset, so there is no repository to search.";

  const index = loadIndex();
  const chunks = index.chunks as Chunk[] | undefined;
  const bm25 = index.bm25 as Bm25Index | undefined;
  if (!chunks?.length || !bm25) return "The issue index is empty; there is nothing to search yet.";

  const candidates = rankIssues(chunks, score(bm25, a.query), CANDIDATES).filter((match) => match.issue !== currentIssue());
  if (candidates.length === 0) return `Nothing matched "${a.query}".`;

  const byNumber = new Map(index.issues.map((issue) => [issue.number, issue]));
  const documents = candidates.map((match) => documentFor(byNumber.get(match.issue)!, chunks[match.chunk]?.text ?? ""));

  let ordered = candidates;
  try {
    const scores = await (await loadReranker()).score(a.query, documents);
    ordered = candidates
      .map((match, i) => [match, scores[i] ?? 0] as const)
      .sort((x, y) => y[1] - x[1])
      .map(([match]) => match);
  } catch (error) {
    // The first stage alone still put the answer in the top twenty every time;
    // it just orders them less well. Better a rougher answer than none.
    log(`WARN reranking failed (${(error as Error).message}); returning the first-stage order`);
  }

  const limit = a.limit ?? 3;
  const results = ordered.slice(0, limit).map((match) => {
    const issue = byNumber.get(match.issue)!;
    const chunk = chunks[match.chunk];
    return {
      number: match.issue,
      title: issue.title,
      state: issue.state,
      url: `https://github.com/${REPO}/issues/${match.issue}`,
      // Where the match is, said in the terms the reader can act on: the number
      // to hand to `github__get_issue_comments`, or the body to read with
      // `github__get_issue`.
      matched_in: locationOf(chunk?.source),
      comment: typeof chunk?.source === "number" ? chunk.source : undefined,
      excerpt: (chunk?.text ?? "").slice(0, EXCERPT_BUDGET).trim(),
    };
  });

  log(
    `query ${JSON.stringify(a.query.slice(0, 60))} -> ${results.map((r) => `#${r.number}(${r.matched_in})`).join(", ")}`,
  );
  return JSON.stringify(results, null, 2);
}

/** How a match's origin is named to the caller. */
function locationOf(source: Chunk["source"] | undefined): string {
  if (typeof source === "number") return `comment ${source}`;
  return source === "title" ? "title" : "body";
}

const { tools, dispatch } = buildMcpTools([
  defineMcpTool({
    name: "search_issues",
    description:
      "Search this repository's issues and their discussion by meaning, not by keyword. Ask a whole question — 'why does a branch get created at the first commit rather than up front' — and the issues that answer it come back, most relevant first, with an excerpt. Use it to find why something is the way it is, whether a problem is already known, or whether the work has been attempted before; the comments are usually where the decision was argued, and they are searched too. Read `query` before calling: how the question is phrased, and what language it is in, decide whether the answer comes back at all. The issue this run is working on is excluded from the results, since you can read it directly — so a decision recorded there will not appear here.",
    schema: SEARCH_SCHEMA,
    handler: searchIssues,
  }),
]);

async function main(): Promise<void> {
  // Start the reranker load now, and do not await it. The 63.9 seconds it takes
  // are the same either way; what changes is whether they are spent inside the
  // first search_issues call -- where they exceeded atoma's request timeout and
  // the call failed -- or during the minute the agent spends reading the issue
  // before it searches for anything.
  //
  // Not awaited, so a server whose model cannot be fetched still serves: the
  // failure surfaces on the first search, which falls back to the first-stage
  // ranking rather than returning nothing. Awaiting here would instead hold up
  // the MCP handshake and take the whole run down with it.
  //
  // The rejection handler is what keeps a promise nobody has awaited yet from
  // becoming an unhandled rejection, which is fatal.
  void loadReranker().catch((error) => {
    log(`WARN could not preload the reranker (${(error as Error).message}); the first search will try again`);
  });
  await serveMcpServer({ name: "atoma-search-mcp", version: "1.0.0", tools, dispatch, log });
}
if (import.meta.main) void main();

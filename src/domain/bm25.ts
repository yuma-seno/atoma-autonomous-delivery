/**
 * bm25.ts — the first stage of issue search: cast a net wide enough that the
 * answer is inside it.
 *
 * BM25 is not semantic, and it does not need to be. Its whole job is to hand
 * twenty candidates to a cross encoder that decides which of them actually
 * answers the question. Measured over this repository's 181 issues and 22
 * questions, BM25 alone put the answer inside the top twenty every time —
 * adding a dense vector index alongside it changed the final ranking on zero
 * questions, which is why there is no vector index here to maintain.
 *
 * Pure and synchronous. The I/O half — fetching issues, storing the index —
 * lives in `lib/issue-index.ts`.
 */

/**
 * Where in an issue a passage came from.
 *
 * `"title"` and `"body"` are the issue itself; a number is the 1-based position
 * of the comment in the issue's conversation, counted the way GitHub orders
 * them and the way a person says "the third comment". Carrying this is what
 * lets a search result name the passage it matched instead of handing back the
 * issue and leaving the reader to find it.
 */
export type ChunkSource = "title" | "body" | number;

/** One indexed passage, tagged with the issue and the place it came from. */
export interface Chunk {
  /** Issue or pull request number this passage belongs to. */
  issue: number;
  source: ChunkSource;
  text: string;
}

/** An issue that matched, and the passage of it that scored highest. */
export interface IssueMatch {
  issue: number;
  /** Index into the `chunks` array that was ranked. */
  chunk: number;
  score: number;
}

/**
 * Longest passage to index as one unit.
 *
 * Short enough that one idea dominates a chunk, long enough that a paragraph
 * survives intact. A whole issue as a single unit scores worse: everything in
 * it averages together and nothing stands out.
 */
const CHUNK_LIMIT = 700;

/** Shortest passage worth indexing; below this it is a heading fragment or a stub. */
const MIN_CHUNK = 40;

/**
 * Split a body into passages, on headings first and blank lines after.
 *
 * Markdown headings are where the author already decided one subject ends and
 * the next begins, so they are the natural seam. Blank lines are the fallback
 * for a section that is still too long to be about one thing.
 */
export function splitBody(text: string, limit = CHUNK_LIMIT): string[] {
  return text
    .split(/\n(?=#{1,4}\s)/)
    .flatMap((section) => (section.length > limit ? section.split(/\n\n+/) : [section]))
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= MIN_CHUNK)
    .map((piece) => piece.slice(0, limit));
}

/**
 * Token stream for BM25: character bigrams, plus whole identifiers.
 *
 * Japanese does not put spaces between words, so splitting on whitespace would
 * make a token out of an entire sentence and BM25 would only ever match
 * sentences repeated verbatim. Character bigrams are the standard substitute
 * for a morphological analyser and need no dictionary — which matters for a
 * template that ships to repositories in languages nobody here anticipated.
 *
 * Identifiers are kept whole on top of that, because `commit_and_push` is one
 * thing to search for and its bigrams are noise.
 */
export function tokenize(text: string): string[] {
  const compact = text.toLowerCase().replace(/[\s、。（）()：:,.\n\r\t`*#|[\]{}<>/\\"'-]+/g, "");
  const tokens: string[] = [];
  for (let i = 0; i < compact.length - 1; i++) tokens.push(compact.slice(i, i + 2));
  for (const identifier of text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []) tokens.push(identifier);
  return tokens;
}

/** Term frequencies and lengths, everything BM25 needs that does not depend on the query. */
export interface Bm25Index {
  /** Per document: token -> count. */
  frequencies: Record<string, number>[];
  /** Per document: total token count. */
  lengths: number[];
  /** Token -> how many documents contain it. */
  documentFrequency: Record<string, number>;
  averageLength: number;
}

export function buildIndex(documents: string[]): Bm25Index {
  const frequencies: Record<string, number>[] = [];
  const lengths: number[] = [];
  const documentFrequency: Record<string, number> = {};

  for (const document of documents) {
    const tokens = tokenize(document);
    const counts: Record<string, number> = {};
    for (const token of tokens) counts[token] = (counts[token] ?? 0) + 1;
    for (const token of Object.keys(counts)) documentFrequency[token] = (documentFrequency[token] ?? 0) + 1;
    frequencies.push(counts);
    lengths.push(tokens.length);
  }

  const total = lengths.reduce((sum, length) => sum + length, 0);
  return {
    frequencies,
    lengths,
    documentFrequency,
    averageLength: lengths.length > 0 ? total / lengths.length : 0,
  };
}

const K1 = 1.2;
const B = 0.75;

/** Score every document against a query. Index order in, score order out. */
export function score(index: Bm25Index, query: string): Float64Array {
  const scores = new Float64Array(index.lengths.length);
  const documentCount = index.lengths.length;
  if (documentCount === 0) return scores;

  for (const token of new Set(tokenize(query))) {
    const df = index.documentFrequency[token];
    if (!df) continue;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    for (let i = 0; i < documentCount; i++) {
      const frequency = index.frequencies[i]?.[token];
      if (!frequency) continue;
      const normalised = 1 - B + (B * (index.lengths[i] ?? 0)) / (index.averageLength || 1);
      scores[i] = (scores[i] ?? 0) + (idf * frequency * (K1 + 1)) / (frequency + K1 * normalised);
    }
  }
  return scores;
}

/**
 * The best-scoring issues, one entry each, each naming the passage that won it.
 *
 * A chunk ranking becomes an issue ranking by keeping each issue's best chunk
 * and dropping the rest. An issue discussed at length would otherwise fill the
 * candidate list with its own passages and crowd out everything else.
 *
 * The winning chunk is returned rather than discarded. It is the only thing
 * that knows *why* the issue is here, and both stages downstream want it: the
 * cross encoder should read the passage that matched instead of whatever
 * happens to sit at the top of the issue, and the caller should be shown it.
 * Throwing it away is how a search that found the right issue can still leave a
 * reader concluding the answer is not there.
 */
export function rankIssues(chunks: Chunk[], scores: Float64Array, limit: number): IssueMatch[] {
  const best = new Map<number, IssueMatch>();
  for (let i = 0; i < chunks.length; i++) {
    const issue = chunks[i]?.issue;
    if (issue === undefined) continue;
    const value = scores[i] ?? 0;
    if (value <= 0) continue;
    const previous = best.get(issue);
    if (!previous || previous.score < value) best.set(issue, { issue, chunk: i, score: value });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

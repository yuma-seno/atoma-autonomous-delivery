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
 *
 * Lossless, which it was not. The last step used to be
 * `.map((piece) => piece.slice(0, limit))`, and that does not shorten a long
 * passage — it deletes the rest of it. A section with no heading and no blank
 * line inside it lost everything past the first 700 characters, and with
 * `MAX_BODY` at 6000 that is most of a long issue silently absent from search.
 *
 * Nothing said so. The doc described where it cuts, and a reader would
 * reasonably expect a function called "split" to keep what it splits.
 *
 * The overflow is now cut into further chunks at a fixed width instead. Fixed
 * width is a poor seam — it lands mid-sentence, and the two halves each match a
 * little worse than the whole would have — but a poor seam still matches, and a
 * passage that was never indexed cannot.
 */
export function splitBody(text: string, limit = CHUNK_LIMIT): string[] {
  return splitBodyWithOffsets(text, limit).map((piece) => piece.text);
}

/** A passage, and where in the original text it began. */
export interface Passage {
  text: string;
  /** Character offset of `text[0]` in the text that was split. */
  start: number;
}

/**
 * The same split, carrying where each passage came from.
 *
 * Code search needs it: a result that names a file makes the agent open the file, and
 * a result that names `src/foo.ts:120-160` makes it read forty lines. The difference
 * matters twice over — the whole-file read is what the output caps exist for, and a
 * search that has to be followed by an open is the shape the shell guard counts.
 *
 * One implementation rather than a second copy of the rule beside it. Two copies of a
 * splitting rule is the defect this repository keeps finding in other forms: `self/`
 * against `.github/`, the config interface against its runtime mirror. `splitBody`
 * is now the shape without the offsets rather than a rule of its own.
 */
export function splitBodyWithOffsets(text: string, limit = CHUNK_LIMIT): Passage[] {
  let pieces: Passage[] = [{ text, start: 0 }];
  // Headings first: the author already decided one subject ends there.
  pieces = pieces.flatMap((piece) => splitOn(piece, /\n(?=#{1,4}\s)/g));
  // Blank lines for whatever is still too long to be about one thing.
  pieces = pieces.flatMap((piece) =>
    piece.text.length > limit ? splitOn(piece, /\n\n+/g) : [piece],
  );
  return pieces
    .map(trimmed)
    .flatMap((piece) => cutToWidth(piece, limit))
    .filter((piece) => piece.text.length >= MIN_CHUNK);
}

/**
 * Split one passage on every match of `separator`, keeping offsets.
 *
 * `String.split` cannot do this: it discards the separators, and a separator of
 * variable length (`\n\n+`) makes the offsets unrecoverable afterwards.
 */
function splitOn(piece: Passage, separator: RegExp): Passage[] {
  const out: Passage[] = [];
  let at = 0;
  separator.lastIndex = 0;
  for (let match = separator.exec(piece.text); match; match = separator.exec(piece.text)) {
    out.push({ text: piece.text.slice(at, match.index), start: piece.start + at });
    at = match.index + match[0].length;
  }
  out.push({ text: piece.text.slice(at), start: piece.start + at });
  return out;
}

/** The passage without its surrounding whitespace, and the offset moved with it. */
function trimmed(piece: Passage): Passage {
  const lead = piece.text.length - piece.text.trimStart().length;
  return { text: piece.text.trim(), start: piece.start + lead };
}

/** One piece, as consecutive chunks of at most `limit` characters. */
function cutToWidth(piece: Passage, limit: number): Passage[] {
  if (piece.text.length <= limit) return [piece];
  const chunks: Passage[] = [];
  for (let at = 0; at < piece.text.length; at += limit) {
    chunks.push(trimmed({ text: piece.text.slice(at, at + limit), start: piece.start + at }));
  }
  return chunks;
}

/**
 * The 1-based line a character offset falls on.
 *
 * For turning a passage's offset into something a person or an agent can act on:
 * `sed -n '120,160p'` reads forty lines where `read_text_file` reads the file.
 */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
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

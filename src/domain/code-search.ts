/**
 * code-search.ts — finding the code that answers a question, rather than the lines
 * that contain a word.
 *
 * # What was measured, and what it decided
 *
 * The same two stages as the issue search: BM25 casts a net, a cross encoder reads the
 * twenty passages it caught. Against this repository's 266 files and 5,053 passages:
 *
 * ```text
 *   query form                            n   recall@1   recall@5   recall@20
 *   regex fragments (machine-labelled)  142      12.7%      41.5%       64.8%
 *   whole questions (hand-labelled)      30      36.7%      70.0%      93.3%
 * ```
 *
 * Same index, same BM25, same corpus. **Only the query changed.** Which is the same
 * finding the issue search made — phrasing was worth more than every other change
 * combined — and it is why the tool description spends its length on how to ask.
 *
 * The two rows are labelled differently on purpose. The fragments are every search in
 * the stored sessions paired with the file the agent opened next, which is a noisy
 * label: reading them, perhaps half are "what it opened next" rather than what it was
 * looking for. The questions are hand-written from the intents those fragments reveal,
 * with labels checked by hand. The absolute figures differ in how much they can be
 * trusted; the contrast does not, because both ran against the same index.
 *
 * An earlier version of this comment claimed 96.7% and 80%. Those were measured on a
 * CRLF checkout, where `splitBody` never splits on a blank line — `\r\n\r\n` has no
 * two adjacent newlines — so the passages were 3,368 instead of 5,053 and coarser than
 * anything production builds. The numbers above are on the runner's chunks.
 *
 * **No embedding model, and no vector store.** A dense index changed nothing for
 * issues; for code the first stage already hands the answer to the reranker 93.3% of
 * the time for a well-phrased question, and a reranker cannot help with what never
 * reaches it. Two cheaper ideas were measured and thrown out as well:
 *
 * ```text
 *   splitting identifiers at index time   +1.4 points
 *   chunking at declaration boundaries    -2.8 points  (worse)
 * ```
 *
 * The second one is worth recording because it sounded right: this repository writes
 * long doc comments that state intent in prose, and keeping a comment with the
 * declaration it documents should have bridged "retry logic" to `backoff_delay`. It
 * did not. The existing rule — headings, then blank lines — beats it.
 *
 * # A question in the wrong language reaches nothing
 *
 * Measured on the first real use: three Japanese questions against this English
 * corpus, and the answer was outside the top twenty for all three. The files that
 * answer them share **zero** tokens with the question; what comes back is whichever
 * files happen to contain Japanese, which here is a test fixture.
 *
 * That is not a caveat to document and hope about. The description said it, and the
 * agent asked in Japanese anyway — because the issue it was working on was Japanese,
 * which is the natural thing to do. So `queryCoverage` measures it instead: the
 * fraction of the question's own tokens the corpus has any word for.
 *
 * ```text
 *   30 English questions   min 98.1%, median 100%
 *   4 Japanese questions   12.0%  13.9%  14.3%  19.4%
 * ```
 *
 * Any threshold between 30% and 60% flags all four and none of the thirty. Nothing
 * about it knows what a language is, so it holds for one nobody here anticipated.
 *
 * # A name that does not exist is a separate failure, and needs a separate signal
 *
 * An earlier version of this comment claimed coverage also caught a question built
 * from invented identifiers. It does not, and the verification run showed it:
 * `how does the FrobnicatorWidget reconcile its ZuffleBuffer` scores **96.3%** and is
 * answered with three unrelated files. The reason is the tokenizer. An invented name
 * that looks like English is made of bigrams an English corpus already has; only the
 * whole-identifier token is missing, and it is one token among dozens.
 *
 * So the name is checked as a name. A word the asker spells like an identifier — an
 * internal capital or an underscore — is a claim that the thing exists, and that claim
 * is either true of the index or it is not:
 *
 * ```text
 *   3 invented-name questions      flagged 3
 *   5 real-identifier questions    flagged 0
 *   the 30 hand-labelled questions flagged 0
 * ```
 *
 * It is a note attached to the results rather than a refusal, and that asymmetry is
 * deliberate. A foreign-language question has no salvageable result at all, so refusing
 * loses nothing. A missing name can be missing for innocent reasons, and one turned up
 * the moment this was measured against the real corpus: `session_size` is reported
 * missing although `src/domain/session-size.ts` is right there, because the tokenizer
 * splits on the hyphen and never forms that token. A name can also live in a file
 * `code-corpus.ts` excludes, or be one the run is about to create. Meanwhile the rest of
 * the question still ranks. A note costs a sentence when it is wrong; a refusal would
 * cost the answer — which is why the wording says "not under that spelling" rather than
 * "not in this codebase".
 *
 * One consequence worth knowing before trying the example above: naming an invented
 * identifier in a comment puts it in the index, so `FrobnicatorWidget` is now a word
 * this repository contains and no longer triggers its own illustration. Prose is
 * indexed exactly like code, which is what makes the search work at all.
 *
 * # No index is stored
 *
 * Measured, building the whole thing from nothing takes 275ms: 6ms to walk the tree,
 * 13ms to read every file, 3ms to split, 271ms for BM25. Against a reranker that takes
 * 55 seconds to load and an inference turn that takes 3.5 seconds, that is noise.
 *
 * So it is built per search, and the freshness question does not exist: the agent
 * edits a file and the next search sees the edit. The issue index is cached on
 * `atoma-data` for a reason that does not apply here — fetching issues needs the
 * network, and code is already on disk. The two share the word "index" and nothing
 * else.
 */
import { lineAt, splitBodyWithOffsets, tokenize, type Bm25Index } from "./bm25.ts";

/** How many passages the cross encoder reads. Twenty, as for issues. */
export const CANDIDATES = 20;

/**
 * Below this share of a question's words being present in the corpus, the question
 * cannot be answered by it.
 *
 * Measured: 30 English questions scored 98.1% at worst, four Japanese ones 12–19.4%.
 * Any threshold in 30–60% separates them completely, so 40% sits in the middle of a
 * band with a fivefold margin on each side rather than on an edge of it.
 */
export const MIN_QUERY_COVERAGE = 0.4;

/**
 * How much of the question the corpus has any word for, from 0 to 1.
 *
 * The signal for "this question cannot reach this corpus", whatever the reason. A
 * The signal for "this question is not in this corpus's language". Such a question
 * shares almost no token with it, the first stage scores near zero, the answer never
 * reaches the cross encoder, and what comes back is whichever passages happened to
 * share an accident.
 *
 * It does NOT catch a question built from names that do not exist -- measured, one
 * scores 96.3%, because an invented English-looking name is spelled out of bigrams the
 * corpus already has. `unknownNames` is the signal for that.
 *
 * Deliberately not language detection. Nothing here knows what a language is, which is
 * what lets it hold for a repository written in one nobody here anticipated.
 */
export function queryCoverage(index: Bm25Index, query: string): number {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return 1;
  const known = tokens.filter((token) => index.documentFrequency[token] !== undefined);
  return known.length / tokens.length;
}

/**
 * Why this question cannot be answered, or nothing.
 *
 * Returned instead of results, not alongside them. The results in this case are
 * whichever passages shared an accident, and handing those back invites the agent to
 * read the wrong file believing it is the right one — which is worse than saying
 * nothing, and is exactly what happened on the first real use.
 */
export function unreachableQueryReason(
  coverage: number,
  limit = MIN_QUERY_COVERAGE,
): string | undefined {
  if (coverage >= limit) return undefined;
  return (
    `Only ${Math.round(coverage * 100)}% of the words in that question appear anywhere in this ` +
    "codebase, so the search cannot match it: the first stage scores near zero and the answer " +
    "never reaches the second. This is what happens when the question is in a different " +
    "language from the code and its comments, or is built from names that do not exist. Ask " +
    "again in the language the code is written in, using the words the code uses — read a file " +
    "first if you are not sure which that is."
  );
}


/**
 * A word spelled the way code spells a name: an internal capital, or an underscore.
 *
 * `stackedPrBase` and `watch_for_stop` are claims that a thing exists by that name;
 * `branch` and `stop` are ordinary words that happen to appear in code. Only the first
 * kind can be checked against the index and be wrong, so only the first kind is
 * checked -- which is what keeps this off the 30 hand-labelled questions, none of
 * which name anything.
 */
const NAME_LIKE = /\b(?=[A-Za-z_]*[A-Z_])[A-Za-z_][A-Za-z0-9_]{2,}\b/g;

/**
 * The names the question claims exist, that the index has never seen.
 *
 * Measured on the verification run: 3 of 3 invented-name questions flagged, 0 of 5
 * questions naming real identifiers, 0 of the 30 hand-labelled questions. `queryCoverage`
 * cannot see this case at all -- an invented English-looking name scores 96.3%, because
 * its bigrams are all bigrams the corpus already has and only the whole identifier is
 * missing.
 *
 * Compared case-insensitively because `tokenize` lowercases, so `MIN_QUERY_COVERAGE`
 * and `min_query_coverage` are the same token here. That also means a real name written
 * in the wrong case is not reported, which is the safe direction for a signal that is
 * advisory.
 */
export function unknownNames(index: Bm25Index, query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of query.match(NAME_LIKE) ?? []) {
    const token = name.toLowerCase();
    if (seen.has(token) || index.documentFrequency[token] !== undefined) continue;
    seen.add(token);
    out.push(name);
  }
  return out;
}

/**
 * What to say about names the codebase does not have, or nothing.
 *
 * A note beside the results, not instead of them -- see the module comment for why this
 * one is advisory where the language check is a refusal. Its job is to make the premise
 * visible: the run that found this defect was handed three unrelated files for a
 * question about two names that exist nowhere, and nothing in that answer said so.
 */
export function unknownNamesNotice(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  const listed = names.map((name) => "`" + name + "`").join(", ");
  const [subject, verb, appear, them] =
    names.length === 1
      ? ["That name", "does", "appears", "it"]
      : ["Those names", "do", "appear", "them"];
  return (
    `Note: ${listed} ${appear} nowhere in the indexed code, so nothing below matches ${them} — ` +
    `the results are ranked on the rest of the question. ${subject} ${verb} not exist under ` +
    "that spelling; check it, or consider that the code may live in a file the index leaves " +
    "out (the .github/ tree, generated output, lock files), which a `grep` would still find."
  );
}
/**
 * How much of a passage the cross encoder is shown.
 *
 * Beyond this its input truncates anyway, and a passage is at most 700 characters, so
 * this is the passage plus the path with room to spare.
 */
export const DOCUMENT_BUDGET = 1000;

/** One indexed passage of one file. */
export interface CodePassage {
  path: string;
  text: string;
  /** 1-based, inclusive, so `sed -n '120,160p'` reads exactly this. */
  startLine: number;
  endLine: number;
}

/**
 * Every passage of one file, with the lines it occupies.
 *
 * The path is indexed as a passage of its own, spelled out as words. A question like
 * "where is the in-progress label managed" should find
 * `src/scripts/manage_in_progress_label.ts` by its name even when no passage inside it
 * says so — and file names in this repository are written to be read that way.
 */
export function passagesOf(path: string, text: string): CodePassage[] {
  // Line endings are normalised first, and this is not cosmetic. `splitBody` separates
  // passages on a blank line, which it recognises as two adjacent newlines -- and
  // `\r\n\r\n` has none. A CRLF checkout therefore produces markedly coarser
  // passages than the runner's LF one: measured on this repository, 3,368 against
  // 5,053. That silently changed what a measurement meant once already, so the split
  // no longer depends on which platform checked the file out. Each \r\n becomes one
  // \n, so the line count is unchanged and the offsets below name the same lines.
  const body = text.includes("\r\n") ? text.split("\r\n").join("\n") : text;
  const out: CodePassage[] = [];
  for (const piece of splitBodyWithOffsets(body)) {
    out.push({
      path,
      text: piece.text,
      startLine: lineAt(body, piece.start),
      endLine: lineAt(body, piece.start + piece.text.length),
    });
  }
  out.push({
    path,
    text: `${path.replace(/[/_.-]/g, " ")} ${path}`,
    startLine: 1,
    endLine: 1,
  });
  return out;
}

/** A passage that matched, and how well. */
export interface PassageMatch {
  /** Index into the passages array that was scored. */
  passage: number;
  score: number;
}

/**
 * The best-scoring passage of each file, best files first.
 *
 * One result per file, like the issue search returns one result per issue. Three
 * passages of one 2,000-line file is a worse answer than three files, and a file whose
 * every passage scores a little is usually a file about something else.
 */
export function rankFiles(
  passages: readonly CodePassage[],
  scores: Float64Array,
  limit: number,
): PassageMatch[] {
  const best = new Map<string, PassageMatch>();
  for (let i = 0; i < passages.length; i += 1) {
    const score = scores[i] ?? 0;
    if (score <= 0) continue;
    const path = passages[i]!.path;
    const current = best.get(path);
    if (!current || current.score < score) best.set(path, { passage: i, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * What the cross encoder is shown for one candidate.
 *
 * The path is part of it, not decoration. `src/domain/session-size.ts` tells a
 * multilingual cross encoder most of what the file is about before it reads a line,
 * and for the passage that IS the path it is all there is.
 */
export function documentFor(passage: CodePassage): string {
  return `${passage.path}\n${passage.text}`.slice(0, DOCUMENT_BUDGET);
}

/** A result, as the caller receives it. */
export interface CodeResult {
  path: string;
  /** `120-160`, ready for `sed -n`. */
  lines: string;
  excerpt: string;
}

/**
 * The results, in the terms the caller can act on next.
 *
 * A line range rather than a file name, because the next act should be reading forty
 * lines and not a file. That matters twice: a whole-file read is what the output caps
 * exist for, and a search that must be followed by an open is the shape the shell
 * guard counts against the agent.
 */
export function resultsOf(
  passages: readonly CodePassage[],
  matches: readonly PassageMatch[],
  excerptBudget: number,
): CodeResult[] {
  return matches.map((match) => {
    const passage = passages[match.passage]!;
    return {
      path: passage.path,
      lines: `${passage.startLine}-${passage.endLine}`,
      excerpt: passage.text.slice(0, excerptBudget).trim(),
    };
  });
}

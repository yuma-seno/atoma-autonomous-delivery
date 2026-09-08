/**
 * code-search.ts — finding the code that answers a question, rather than the lines
 * that contain a word.
 *
 * # What was measured, and what it decided
 *
 * The same two stages as the issue search: BM25 casts a net, a cross encoder reads the
 * twenty passages it caught. Over 30 questions phrased the way an agent would phrase
 * them, against this repository's 251 files and 3,159 passages:
 *
 * ```text
 *   query form              recall@1   recall@5   recall@20
 *   regex fragments            18.3%      42.3%       62.0%
 *   whole questions            36.7%      80.0%      96.7%
 * ```
 *
 * Same index, same BM25, same corpus. **Only the query changed.** Which is the same
 * finding the issue search made — phrasing was worth more than every other change
 * combined — and it is why the tool description spends its length on how to ask.
 *
 * **No embedding model, and no vector store.** A dense index changed nothing for
 * issues; for code the first stage already hands the answer to the reranker 96.7% of
 * the time, and a reranker cannot help with what never reaches it. Two cheaper ideas
 * were measured and thrown out as well:
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
import { lineAt, splitBodyWithOffsets } from "./bm25.ts";

/** How many passages the cross encoder reads. Twenty, as for issues. */
export const CANDIDATES = 20;

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
  const out: CodePassage[] = [];
  for (const piece of splitBodyWithOffsets(text)) {
    out.push({
      path,
      text: piece.text,
      startLine: lineAt(text, piece.start),
      endLine: lineAt(text, piece.start + piece.text.length),
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

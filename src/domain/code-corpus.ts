/**
 * code-corpus.ts — which of a project's files the code search reads.
 *
 * # Why `git ls-files` and not a configured list
 *
 * A template does not know where an adopter keeps their source. `git ls-files` is the
 * answer they already gave: it is exactly what the project tracks, it respects
 * `.gitignore`, and it needs no key in `config.json` — which #399 is about not adding.
 *
 * The I/O half is the caller's. This module decides what to keep.
 *
 * # Why the exclusions are what they are
 *
 * `.github/atoma/**` and `.github/scripts/**` are the DEPLOYED machinery, generated
 * from `src/` by `build-dist.ts`. Excluding them serves both kinds of repository for
 * different reasons: in this one they are a second copy of `src/`, so a search would
 * return the copy; in an adopter's, they are Atoma's implementation, so a question
 * about their own project would be answered with ours.
 *
 * **Tests are indexed.** "Where is this tested" is a question worth answering, and
 * leaving them out would be a guess about what somebody else wants to find.
 *
 * # Why there is no size limit on a file
 *
 * A file too large to be about one thing still splits into passages that are, and a
 * passage that was never indexed cannot be found. The cost is bounded elsewhere:
 * measured, this repository is 251 files and 3,159 passages, and building the whole
 * index from nothing takes 275ms — which is why there is no cache either.
 */

/** Extensions worth reading as text. */
const INDEXED = /\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|sql|md|mdx|yaml|yml|toml|json|jsonc)$/i;

/**
 * Paths that are generated, locked, or otherwise not the project's own writing.
 *
 * Lock files are the case worth naming: `bun.lock` is 300KB of resolved versions, all
 * of it matching any query about a package name, and none of it an answer to anything.
 */
const EXCLUDED = [
  // The deployed machinery. See the module comment.
  /^\.github\/atoma\//,
  /^\.github\/scripts\//,
  /^\.github\/workflows\/.*\.yml$/,
  // Generated output, whatever a project calls it.
  /(^|\/)(dist|build|out|coverage|vendor|node_modules|target|\.next|__pycache__)\//,
  // Resolved dependency graphs.
  /(^|\/)(package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock)$/,
  // Snapshots: a test's recorded output, not its intent.
  /(^|\/)__snapshots__\//,
];

/** Whether the code search should read this path. */
export function shouldIndex(path: string): boolean {
  if (!INDEXED.test(path)) return false;
  return !EXCLUDED.some((pattern) => pattern.test(path));
}

/**
 * The corpus, from whatever `git ls-files` returned.
 *
 * Sorted, so an index built twice from the same tree is the same index and a ranking
 * does not depend on the order a directory happened to be walked in.
 */
export function corpusFrom(tracked: readonly string[]): string[] {
  return tracked
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((path) => path.length > 0 && shouldIndex(path))
    .sort();
}

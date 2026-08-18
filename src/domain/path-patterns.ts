/**
 * path-patterns.ts — the one path-pattern form Atoma's configuration accepts.
 *
 * A pattern is a literal path, or a directory followed by `/**`. That is all.
 * Deliberately not a glob library, and the reason is not laziness: a
 * half-implemented glob is read as a full one. Someone writes `**\/*.sql`,
 * matches nothing, and their gate silently never fires -- which is worse than no
 * gate at all, because they believe they have one.
 *
 * So the form is small AND checked. `pathPatternProblem` rejects anything this
 * matcher cannot honour, and every caller reports that as a configuration
 * problem rather than matching zero files and carrying on. A pattern that cannot
 * work now says so at the moment it is read.
 *
 * Extracted from `merge-readiness.ts`, where `governedPathsIn` had the matcher
 * inline. `merge_gates` needed the same one, and two copies of a security-shaped
 * comparison is exactly the arrangement that drifts.
 */

/** Whether `pattern` claims `file`. */
export function pathMatches(file: string, pattern: string): boolean {
  return pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}

/**
 * Why `pattern` is not one `pathMatches` can honour, or "" when it is fine.
 *
 * The wildcard check is the point. A trailing `/**` is the supported form; a `*`
 * anywhere else -- `**\/*.sql`, `db/*\/migrations/**`, `*.ts` -- would be compared
 * literally and match nothing.
 */
export function pathPatternProblem(pattern: string): string {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return "a path pattern must be a non-empty string";
  }
  if (pattern !== pattern.trim()) {
    return `"${pattern}" has surrounding whitespace`;
  }
  const firstStar = pattern.indexOf("*");
  if (firstStar === -1) return "";
  if (pattern.endsWith("/**") && firstStar === pattern.length - 2) return "";
  return (
    `"${pattern}" uses a wildcard this matcher cannot honour, so it would match nothing. ` +
    'Write a literal path, or a directory followed by "/**".'
  );
}

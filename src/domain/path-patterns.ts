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
 * matcher cannot honour, and both callers -- `merge_gates` and `governed_paths`
 * -- report that as a configuration problem rather than matching zero files and
 * carrying on. A pattern that cannot work says so at the moment it is read.
 *
 * `governed_paths` was not checked for a while, and the header here claimed it
 * was. That is the worse half of the same mistake: a gate over the agent's own
 * limits, silently matching nothing, under a comment saying it could not.
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
const GLOB_CHARACTERS = /[*?[\]{}]/;

export function pathPatternProblem(pattern: string): string {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return "a path pattern must be a non-empty string";
  }
  if (pattern !== pattern.trim()) {
    return `"${pattern}" has surrounding whitespace`;
  }

  // A trailing slash is the ordinary way a person writes a directory, and it is
  // the one spelling that looks right and claims nothing: `pathMatches` sees no
  // `/**`, falls through to the literal comparison, and no file is ever named
  // with a trailing slash. Caught before the glob check so the message can name
  // the fix rather than the character.
  if (pattern.endsWith("/")) {
    return (
      `"${pattern}" ends in a slash, so it would match nothing. ` +
      `Write "${pattern}**" for everything under it, or drop the slash to match that one path.`
    );
  }

  // Everything except a trailing `/**` is compared literally, so any other glob
  // character is a pattern that reads as a glob and behaves as a filename. A
  // literal path containing one of these is refused too: it could in principle
  // be matched, but telling the two apart needs intent this cannot see, and a
  // refusal a person fixes beats a gate that quietly never fires.
  const body = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  if (body === "") {
    return `"${pattern}" names no directory. Write the directory before the "/**".`;
  }
  const glob = GLOB_CHARACTERS.exec(body);
  if (glob) {
    return (
      `"${pattern}" uses the glob character '${glob[0]}', which this matcher cannot honour, ` +
      'so it would match nothing. Write a literal path, or a directory followed by "/**".'
    );
  }
  return "";
}

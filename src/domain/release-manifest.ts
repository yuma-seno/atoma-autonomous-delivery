/**
 * release-manifest.ts — what a release says about itself.
 *
 * # Two questions an adopted repository could not answer
 *
 * **"Which release am I on?"** `docs/customization.md` tells an adopter to name a
 * version rather than `latest`, and to record which one they took, because that is
 * what makes the next diff readable. It never gave them anywhere to record it, and
 * nothing in `.github/atoma/` said. So the answer was memory, or downloading a zip
 * and diffing.
 *
 * **"What did upstream delete?"** The documented upgrade is `unzip -o` over the
 * tree, and that only ever overwrites. A file we removed stays in their repository
 * forever, and this is not cosmetic: #486 deleted `atoma-auto-trigger.yml` and
 * `atoma-pr-review.yml` because work should start only when somebody asks. An
 * adopter who upgrades keeps both files, keeps the triggers, and keeps the
 * behaviour we removed — with nothing anywhere saying so.
 *
 * # What this is
 *
 * One JSON file in the release, carrying the version and every path the release
 * ships. The version answers the first question. The list answers the second:
 * anything under the paths we own that is not in the list is something upstream no
 * longer ships.
 *
 * It is data rather than a program on purpose. An adopter with a shell can answer
 * both questions from it, and so can we -- and neither has to trust a tool that
 * would have to be upgraded to be believed.
 */

/** The file the release carries, at the root of what it ships. */
export const MANIFEST_PATH = ".github/atoma-release.json";

export interface ReleaseManifest {
  /** The release this tree came from, as the tag names it: `v0.1.77`. */
  version: string;
  /** Every path the release ships, repository-relative, sorted. */
  files: string[];
}

/**
 * The manifest for a version and a set of paths.
 *
 * Sorted, because the file is meant to be diffed between releases: two manifests
 * whose entries are in filesystem-walk order differ wherever the walk did, which
 * would bury the change that matters.
 *
 * The manifest names itself. That is not a curiosity: an adopter comparing their
 * tree against the list would otherwise find the manifest itself in the tree and
 * not in the list, and conclude that upstream had deleted it.
 */
export function buildManifest(version: string, files: Iterable<string>): ReleaseManifest {
  const all = new Set([...files].map((path) => path.replace(/\\/g, "/")));
  all.add(MANIFEST_PATH);
  return { version, files: [...all].sort() };
}

/**
 * Paths present in a tree and not in the release: what upstream no longer ships.
 *
 * `tree` is what the adopter has under the paths the release owns. Only those:
 * asking about `.github/workflows/their-own-ci.yml` would report every file they
 * wrote themselves as deleted upstream, which is how a warning gets ignored.
 */
export function noLongerShipped(manifest: ReleaseManifest, tree: Iterable<string>): string[] {
  const shipped = new Set(manifest.files);
  return [...tree].map((path) => path.replace(/\\/g, "/")).filter((path) => !shipped.has(path)).sort();
}

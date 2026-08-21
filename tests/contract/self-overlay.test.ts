import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `self/` and `.github/` do not drift apart.
 *
 * ## What this replaced
 *
 * `.github/` used to be the release archive extracted over the previous contents,
 * with three files kept alive by remembering to run `git checkout --` on them
 * afterwards. Two things went wrong with that, and both were silent:
 *
 * - a file the upstream release had **deleted** stayed in the tree. `unzip -o`
 *   overwrites and never removes, so there was no diff to notice it by. The old
 *   `conventions.md` said to "look for orphans under `.github/atoma/` yourself".
 * - the preserve list lived in a person's memory. `config.json` was restored every
 *   time because it was remembered, not because anything checked.
 *
 * `self/` mirrors `.github/`, so the deploy became `rm -rf .github`, extract, copy
 * `self/` over it. An upstream removal is now ordinary -- the file is not recreated
 * -- and the preserve list is a directory rather than a habit.
 *
 * ## What these tests hold
 *
 * That the two copies of every overlay file agree, in both directions: the file
 * exists in both places, and holds the same bytes.
 *
 * An overlay entry needs no release to take effect -- it is a copy, not a build --
 * so a change to `self/X` belongs in the same pull request as the identical change
 * to `.github/X`. This is what turns "remember to change both" into a failing
 * check, and it is why an agent improving `config.json` cannot half-apply it.
 *
 * ## Why there is no "every file in `.github/` is accounted for" test
 *
 * There was one, and it was wrong. It required every file under `.github/` to
 * exist in `dist/.github/` or `self/`, meaning to catch a file that accumulated.
 *
 * Nothing accumulates any more. The deploy runs `rm -rf .github` first, so a file
 * the release stopped shipping is simply not recreated -- which is the whole reason
 * `self/` exists. There is nothing left for that test to find.
 *
 * Worse, it was a false alarm waiting to happen. `dist/` is built from the CURRENT
 * `src/`, while `.github/` holds an older release, and the lag between them is
 * deliberate: a change to `src/` must not reconfigure the live agents the moment it
 * merges, and two breakages reached the running system exactly that way. So merge a
 * change that DELETES a file from `src/`, then deploy a release that predates it,
 * and the test fails on a correct deploy pull request.
 *
 * The one case it did cover on its own -- a file added to `.github/` with no
 * counterpart in `self/`, which the next deploy would silently remove -- is already
 * in front of a person. `.github/**` is in `governed_paths`, so any pull request
 * touching it carries the blocker "this pull request changes how agents themselves
 * run" and cannot be merged by an agent at all.
 *
 * These tests likewise do not check that `.github/` matches the current `src/`, for
 * the same reason: the lag is the design, not a defect to detect.
 */
const OVERLAY = "self";
const DEPLOYED = ".github";
const BUILT = "dist/.github";

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Line endings normalised, because this repository is developed on Windows and
 * `.github/` is checked out CRLF while `dist/` is written LF by the build. A
 * comparison that called every file different would report nothing.
 */
function body(path: string): string {
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

describe("`self/` and `.github/` hold the same overlay", () => {
  test("every file in self/ has a counterpart in .github/", () => {
    const missing = filesUnder(OVERLAY).filter((file) => !existsSync(join(DEPLOYED, file)));
    expect(
      missing,
      `these are in ${OVERLAY}/ but not in ${DEPLOYED}/. The overlay is a copy and needs no ` +
        `release to apply, so add them in this same change`,
    ).toEqual([]);
  });

  test("self/ and .github/ hold the same bytes", () => {
    const differing = filesUnder(OVERLAY).filter(
      (file) => existsSync(join(DEPLOYED, file)) && body(join(OVERLAY, file)) !== body(join(DEPLOYED, file)),
    );
    expect(
      differing,
      `${OVERLAY}/ is the source for these and ${DEPLOYED}/ is a copy of it, so they must match. ` +
        `Editing ${DEPLOYED}/ alone is worse than not editing it: the next self-deploy overwrites ` +
        `it from ${OVERLAY}/ and the change disappears with no diff to notice it by`,
    ).toEqual([]);
  });

  /**
   * The overlay must not shadow a file the deliverable also ships. Two copies of
   * one path, one of which always wins, is the situation `self/` exists to end --
   * and it would look like a working customisation right up to the release that
   * changed the shipped copy.
   *
   * `config.json` is the deliberate exception and the only one: the release
   * carries an example, every adopter replaces it, and this repository is an
   * adopter.
   */
  test("the overlay does not shadow the deliverable, except config.json", () => {
    // Unlike the membership test this replaced, comparing against `dist/` is right
    // here: the question is whether what `src/` ships TODAY is also overridden in
    // `self/`, and `dist/` is exactly that. No lag is involved.
    if (!existsSync(BUILT)) {
      console.warn(`${BUILT} is absent; run \`bun run synth\` for this test to mean anything`);
      return;
    }
    const shadowed = filesUnder(OVERLAY)
      .filter((file) => existsSync(join(BUILT, file)))
      .filter((file) => file !== "atoma/config.json");
    expect(
      shadowed,
      `the deliverable ships these too, so ${OVERLAY}/ silently overrides them. If the intent is ` +
        `to change them for everyone, change src/; if only for this repository, that is a fork of ` +
        `a shipped file and needs saying out loud`,
    ).toEqual([]);
  });

  /**
   * The self-deploy workflow is the one thing here that cannot be regenerated, and
   * the one holding a token. Pinning both facts: it exists in the overlay, and
   * nothing in the deliverable knows about the secret.
   */
  test("the self-deploy workflow is this repository's own, and the deliverable never names its token", () => {
    expect(existsSync(join(OVERLAY, "workflows/atoma-self-deploy.yml"))).toBe(true);
    expect(existsSync(join(BUILT, "workflows/atoma-self-deploy.yml")), "it must not be shipped").toBe(false);

    // An adopter receiving a reference to this secret would get a workflow that
    // cannot run, and -- worse -- a name suggesting Atoma expects a PAT.
    for (const file of filesUnder("src")) {
      if (!/\.(ts|yml|yaml|md|json)$/.test(file)) continue;
      expect(
        body(join("src", file)),
        `src/${file} names ATOMA_SELF_DEPLOY_TOKEN; that secret is this repository's own`,
      ).not.toContain("ATOMA_SELF_DEPLOY_TOKEN");
    }
  });
});

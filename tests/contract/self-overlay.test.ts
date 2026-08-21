import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `.github/` is the release plus `self/`, and nothing else.
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
 * `self/` over it. An upstream removal is now ordinary — the file is not recreated
 * — and the preserve list is a directory rather than a habit.
 *
 * ## What these tests hold
 *
 * **Nothing unaccounted for in `.github/`.** Every file there must come from the
 * deliverable or from `self/`. This is what catches a file that accumulated: added
 * by hand, or left behind by a release that stopped shipping it.
 *
 * **`self/` and `.github/` agree.** An overlay entry needs no release to take
 * effect — it is a copy — so a change to `self/X` belongs in the same pull request
 * as the identical change to `.github/X`. Requiring them byte-identical is what
 * turns "remember to change both" into a failing check, and it is the reason an
 * agent improving `config.json` cannot half-apply the change.
 *
 * ## What they do not hold
 *
 * That `.github/` matches the CURRENT `src/`. It deliberately lags: a change to
 * `src/` must not reconfigure the live agents the moment it merges, and two
 * breakages reached the running system exactly that way. So membership is checked
 * against `dist/`, and content is not.
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

describe("`.github/` is the deliverable plus `self/`", () => {
  test("every file in .github/ comes from the deliverable or from self/", () => {
    // `dist/` is gitignored and built by `bun run synth`, which runs in checks
    // before this. Skipping rather than failing when it is absent: a developer
    // running one test file has not necessarily built, and a false failure here
    // would teach them to ignore this test.
    if (!existsSync(BUILT)) {
      console.warn(`${BUILT} is absent; run \`bun run synth\` for this test to mean anything`);
      return;
    }

    const shipped = new Set(filesUnder(BUILT));
    const owned = new Set(filesUnder(OVERLAY));
    const unaccounted = filesUnder(DEPLOYED).filter((file) => !shipped.has(file) && !owned.has(file));

    expect(
      unaccounted,
      `these exist under ${DEPLOYED}/ but come from neither the deliverable nor ${OVERLAY}/. ` +
        `Either the build stopped producing them (delete them) or they belong to this repository ` +
        `(move them to ${OVERLAY}/, which the deploy copies over the release)`,
    ).toEqual([]);
  });

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
    if (!existsSync(BUILT)) return;
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

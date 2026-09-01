import { describe, expect, test } from "bun:test";
import { buildManifest, MANIFEST_PATH, noLongerShipped } from "./release-manifest.ts";

describe("what a release says about itself", () => {
  test("it carries the version, so an adopted tree can answer which one it is", () => {
    expect(buildManifest("v0.1.77", []).version).toBe("v0.1.77");
  });

  /**
   * The file is meant to be diffed between releases. Two manifests in
   * filesystem-walk order differ wherever the walk did, which buries the change
   * somebody is looking for.
   */
  test("the list is sorted", () => {
    const manifest = buildManifest("v1", [".github/workflows/b.yml", ".github/atoma/a.json"]);
    expect(manifest.files).toEqual([
      ".github/atoma-release.json",
      ".github/atoma/a.json",
      ".github/workflows/b.yml",
    ]);
  });

  /**
   * Otherwise an adopter comparing their tree against the list finds the manifest
   * in the tree and not in the list, and concludes upstream deleted it.
   */
  test("the manifest names itself", () => {
    expect(buildManifest("v1", []).files).toContain(MANIFEST_PATH);
  });

  test("a path is recorded the same way whichever separator produced it", () => {
    const manifest = buildManifest("v1", [".github\\atoma\\config.json"]);
    expect(manifest.files).toContain(".github/atoma/config.json");
  });

  test("the same path listed twice is listed once", () => {
    const manifest = buildManifest("v1", [".github/a", ".github/a"]);
    expect(manifest.files.filter((p) => p === ".github/a")).toHaveLength(1);
  });
});

describe("what upstream no longer ships", () => {
  const manifest = buildManifest("v0.1.77", [
    ".github/workflows/atoma-runner.yml",
    ".github/atoma/config.json",
  ]);

  test("nothing, for a tree that matches", () => {
    expect(noLongerShipped(manifest, [...manifest.files])).toEqual([]);
  });

  /**
   * The case this exists for. #486 deleted two workflows because work should start
   * only when somebody asks; `unzip -o` leaves both in place, and an adopter who
   * upgrades keeps the triggers and the behaviour that was removed.
   */
  test("a workflow the release dropped is reported", () => {
    const tree = [...manifest.files, ".github/workflows/atoma-auto-trigger.yml"];
    expect(noLongerShipped(manifest, tree)).toEqual([".github/workflows/atoma-auto-trigger.yml"]);
  });

  test("several, sorted", () => {
    const tree = [...manifest.files, ".github/workflows/z.yml", ".github/atoma/old.md"];
    expect(noLongerShipped(manifest, tree)).toEqual([
      ".github/atoma/old.md",
      ".github/workflows/z.yml",
    ]);
  });
});

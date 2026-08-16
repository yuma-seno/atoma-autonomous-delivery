import { describe, expect, test } from "bun:test";
import { toArgv } from "./cli.ts";

describe("lib/cli.ts toArgv", () => {
  test("builds quoted --flag value pairs, skipping undefined", () => {
    expect(toArgv({ repo: "owner/repo", parent: 5, empty: undefined })).toEqual(["--repo", '"owner/repo"', "--parent", '"5"']);
  });
});

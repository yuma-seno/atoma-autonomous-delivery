import { describe, expect, test } from "bun:test";
import { pathMatches, pathPatternProblem } from "./path-patterns.ts";

describe("pathMatches", () => {
  test("a directory pattern claims everything under it", () => {
    expect(pathMatches(".github/workflows/ci.yml", ".github/**")).toBe(true);
    expect(pathMatches(".github/scripts/deep/nested.ts", ".github/**")).toBe(true);
  });

  test("a literal pattern claims exactly one path", () => {
    expect(pathMatches("package.json", "package.json")).toBe(true);
    expect(pathMatches("web/package.json", "package.json")).toBe(false);
  });

  test("a directory pattern does not claim a sibling with the same prefix", () => {
    expect(pathMatches("db/migrations-old/x.sql", "db/migrations/**")).toBe(false);
  });
});

describe("pathPatternProblem", () => {
  test("the two supported forms are accepted", () => {
    expect(pathPatternProblem(".github/**")).toBe("");
    expect(pathPatternProblem("db/migrations/**")).toBe("");
    expect(pathPatternProblem("package.json")).toBe("");
  });

  // The reason this function exists. Each of these would be compared literally,
  // match nothing, and leave someone believing they had a gate.
  test("a wildcard anywhere but the trailing /** is rejected", () => {
    for (const pattern of ["**/*.sql", "*.ts", "db/*/migrations/**", "db/mig*/**", "db/**/x.sql"]) {
      expect(pathPatternProblem(pattern), pattern).toContain("glob character");
    }
  });

  // A trailing slash is how most people write a directory, and it was the one
  // spelling that passed this check and then matched nothing — the failure the
  // module exists to prevent, reached through the validator rather than around
  // it. The message names the fix because the fix is one character.
  test("a trailing slash is rejected, and the message says what to write", () => {
    const problem = pathPatternProblem("db/migrations/");
    expect(problem).toContain("match nothing");
    expect(problem).toContain('"db/migrations/**"');
  });

  // Same class: read as a glob, behaved as a filename.
  test("other glob characters are rejected", () => {
    for (const pattern of ["logs/?.txt", "db/[0-9]/x.sql", "src/{a,b}/x.ts", "logs/a].txt"]) {
      expect(pathPatternProblem(pattern), pattern).toContain("glob character");
    }
  });

  test("a directory pattern must name a directory", () => {
    expect(pathPatternProblem("/**")).toContain("names no directory");
  });

  test("empty and untrimmed patterns are rejected", () => {
    expect(pathPatternProblem("")).not.toBe("");
    expect(pathPatternProblem("   ")).not.toBe("");
    expect(pathPatternProblem(" db/** ")).toContain("whitespace");
  });

  test("a non-string is rejected rather than coerced", () => {
    expect(pathPatternProblem(42 as unknown as string)).not.toBe("");
    expect(pathPatternProblem(undefined as unknown as string)).not.toBe("");
  });
});

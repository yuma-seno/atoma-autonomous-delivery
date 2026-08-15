import { describe, expect, test } from "bun:test";
import { literalsFrom, redact, REDACTED } from "./redaction.ts";

describe("redact", () => {
  test("replaces credential-shaped text", () => {
    const cases = [
      "sk-abcdefghijklmnopqrstuvwx",
      "sk-ant-api03-abcdefghijklmnopqrst",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "github_pat_11ABCDEFG0abcdefghijklmn",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-abcdefghij",
      "-----BEGIN RSA PRIVATE KEY-----",
    ];
    for (const secret of cases) {
      expect(redact(`token=${secret} rest`), secret).toBe(`token=${REDACTED} rest`);
    }
  });

  // The output has to stay readable, or people stop trusting it and read the raw
  // log instead — which is the thing this exists to make unnecessary.
  test("leaves ordinary output alone", () => {
    const text = [
      "commit d51da94f2bd237faeed07f553cf51d07b5aee125",
      "test/fixtures/sk-example.json",
      "3 passed, 0 failed in 1.24s",
      "https://github.com/owner/repo/pull/272",
    ].join("\n");
    expect(redact(text)).toBe(text);
  });

  test("replaces a known value even where no pattern would match it", () => {
    const secret = "not-shaped-like-a-key-at-all";
    expect(redact(`X=${secret}`, [secret])).toBe(`X=${REDACTED}`);
  });

  test("replaces every occurrence, not just the first", () => {
    expect(redact("a ghp_aaaaaaaaaaaaaaaaaaaa b ghp_bbbbbbbbbbbbbbbbbbbb")).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  // Otherwise the longer value is left half-redacted and half-readable.
  test("a value containing another is replaced whole", () => {
    const inner = "inner-secret-value";
    const outer = `${inner}-with-more`;
    expect(redact(`v=${outer}`, literalsFrom({ A: inner, B: outer }, ["A", "B"]))).toBe(`v=${REDACTED}`);
  });
});

describe("literalsFrom", () => {
  test("takes the named values, longest first", () => {
    const env = { SHORT: "abc", ONE: "aaaaaaaaaaaaaa", TWO: "bbbbbbbbbbbbbbbbbbbb" };
    expect(literalsFrom(env, ["SHORT", "ONE", "TWO"])).toEqual([env.TWO, env.ONE]);
  });

  // A short variable would match inside unrelated words and redact the output
  // into uselessness.
  test("skips values too short to be a credential", () => {
    expect(literalsFrom({ A: "abc" }, ["A"])).toEqual([]);
  });

  test("skips names that are unset", () => {
    expect(literalsFrom({}, ["MISSING"])).toEqual([]);
  });
});

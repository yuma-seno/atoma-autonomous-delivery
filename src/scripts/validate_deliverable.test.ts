/**
 * validate_deliverable.test.ts — the one piece of that script that is a decision
 * rather than plumbing: reading a verdict out of `atoma validate`'s output.
 *
 * The rest of the script is filesystem and a subprocess, and the rules it applies
 * are tested in `domain/deliverable-integrity.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { validatorProblems } from "./validate_deliverable.ts";

describe("validatorProblems", () => {
  // Shaped like the real thing: `application/validator.rs` prints a ✓ line per
  // thing that was fine to stdout, then a header and one ✗ line per error to
  // stderr.
  const output = [
    "✓ Agent definition parsed: engineer",
    "✓ Tools file parsed: 6 server(s) defined",
    "  ✓ mcp_servers 'filesystem' found in tools file",
    "",
    "Validation failed with 2 error(s):",
    "  ✗ mcp_servers 'shell': not found in tools file \"tools.yaml\"",
    "  ✗ knows_about 'reviewer': definition file not found at \"reviewer.md\"",
  ].join("\n");

  test("takes the errors and nothing else", () => {
    expect(validatorProblems(output)).toEqual([
      "mcp_servers 'shell': not found in tools file \"tools.yaml\"",
      "knows_about 'reviewer': definition file not found at \"reviewer.md\"",
    ]);
  });

  // A passing run says so and lists what it checked. None of that is a problem.
  test("a successful validation yields nothing", () => {
    expect(validatorProblems("✓ Agent definition parsed: engineer\n\nValidation passed.")).toEqual([]);
  });

  test("output with no errors at all yields nothing", () => {
    expect(validatorProblems("")).toEqual([]);
  });

  // Windows line endings, because the file this reads is a subprocess's output and
  // nothing guarantees which the host produced.
  test("reads CRLF output", () => {
    expect(validatorProblems("  ✗ one\r\n  ✗ two\r\n")).toEqual(["one", "two"]);
  });
});

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { REDACTED } from "../domain/redaction.ts";
import { scriptPath } from "./testing/harness.ts";

function run(input: string) {
  return spawnSync("bun", ["run", scriptPath("redact_stream.ts")], { input, encoding: "utf8" });
}

describe("redact_stream.ts", () => {
  // The line the failure excerpt actually greps for. `unauthorized` is what a
  // provider or a `gh` call emits, and it is emitted WITH the credential.
  test("removes a credential from the kind of line the failure excerpt posts", () => {
    const r = run("ERROR 401 unauthorized: key sk-abcdefghijklmnopqrstuvwx rejected\n");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(r.stdout).toContain(REDACTED);
    // The diagnostic value has to survive, or people stop posting the excerpt.
    expect(r.stdout).toContain("401 unauthorized");
  });

  test("leaves ordinary log text alone", () => {
    const text = "error: 3 tests failed in src/domain/handoff.test.ts\ncommit d51da94f2bd237faeed07f553cf51d07b5aee125\n";
    expect(run(text).stdout).toBe(text);
  });

  test("passes empty input through", () => {
    const r = run("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

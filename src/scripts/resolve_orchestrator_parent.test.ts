import { describe, expect, test } from "bun:test";
import { runWithFakeGh, scriptPath } from "./testing/harness.ts";

describe("resolve_orchestrator_parent.ts", () => {
  test("resolves the parent via the GraphQL sub-issues API", () => {
    // gh api graphql wraps the real GraphQL response in a top-level "data"
    // envelope -- lib/gh.ts's ghGraphql() unwraps `.data`, so the fake gh's
    // canned stdout must match that shape too.
    const r = runWithFakeGh(scriptPath("resolve_orchestrator_parent.ts"), ["--repo", "owner/repo", "--sub", "9"], {
      rules: [{ match: ["graphql"], stdout: JSON.stringify({ data: { repository: { issue: { parent: { number: 3 } } } } }) }],
    });
    expect(r.stdout.trim()).toBe("3");
  });

  test("falls back to the atoma:parent body comment when GraphQL has no parent", () => {
    const r = runWithFakeGh(scriptPath("resolve_orchestrator_parent.ts"), ["--repo", "owner/repo", "--sub", "9"], {
      rules: [
        { match: ["graphql"], stdout: JSON.stringify({ data: { repository: { issue: { parent: null } } } }) },
        { match: ["issue", "view"], stdout: "<!-- atoma:parent=4 -->" },
      ],
    });
    expect(r.stdout.trim()).toBe("4");
  });
});

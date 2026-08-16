import { describe, expect, test } from "bun:test";
import type { Session } from "../lib/session.ts";
import { runWithFakeGh, scriptPath } from "./testing/harness.ts";

describe("resolve_notify.ts", () => {
  test("returns the atoma:notify tag when present", () => {
    const r = runWithFakeGh(scriptPath("resolve_notify.ts"), ["--repo", "owner/repo", "--number", "5"], {
      rules: [{ match: ["issues/5"], stdout: JSON.stringify({ body: "<!-- atoma:notify=octocat -->", login: "some-bot", type: "Bot" }) }],
    });
    expect(r.stdout.trim()).toBe("octocat");
  });

  test("falls back to the human author when no tag is present", () => {
    const r = runWithFakeGh(scriptPath("resolve_notify.ts"), ["--repo", "owner/repo", "--number", "5"], {
      rules: [{ match: ["issues/5"], stdout: JSON.stringify({ body: "no tag", login: "alice", type: "User" }) }],
    });
    expect(r.stdout.trim()).toBe("alice");
  });

  test("walks the atoma:parent chain when neither a tag nor a human author is available", () => {
    const r = runWithFakeGh(scriptPath("resolve_notify.ts"), ["--repo", "owner/repo", "--number", "5"], {
      rules: [
        { match: ["issues/5"], stdout: JSON.stringify({ body: "<!-- atoma:parent=2 -->", login: "some-bot", type: "Bot" }) },
        { match: ["issues/2"], stdout: JSON.stringify({ body: "no tag", login: "bob", type: "User" }) },
      ],
    });
    expect(r.stdout.trim()).toBe("bob");
  });
});

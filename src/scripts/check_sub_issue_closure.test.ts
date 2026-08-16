import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGithubOutput, runWithFakeGh, scriptPath } from "./testing/harness.ts";

describe("check_sub_issue_closure.ts", () => {
  test("detects a sub-issue and reports closed_via_pr=false when not closed via PR", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const eventFile = join(dir, "event.json");
      const outputFile = join(dir, "out");
      writeFileSync(eventFile, JSON.stringify({ issue: { body: "<!-- atoma:parent=3 -->\nsome body" } }));
      writeFileSync(outputFile, "");
      runWithFakeGh(scriptPath("check_sub_issue_closure.ts"), [], {
        env: { GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile, CLOSED_NUM: "9", OWNER: "owner", REPO: "repo" },
        // gh api graphql wraps its response in a top-level "data" envelope --
        // ghGraphql() unwraps `.data`, so the fake gh's canned stdout must too.
        rules: [
          {
            match: ["graphql"],
            stdout: JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } } }),
          },
        ],
      });
      const out = parseGithubOutput(readFileSync(outputFile, "utf8"));
      expect(out.is_sub_issue).toBe("true");
      expect(out.parent_number).toBe("3");
      expect(out.closed_via_pr).toBe("false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports closed_via_pr=true when the sub-issue was already closed by a merged PR", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const eventFile = join(dir, "event.json");
      const outputFile = join(dir, "out");
      writeFileSync(eventFile, JSON.stringify({ issue: { body: "<!-- atoma:parent=3 -->\nsome body" } }));
      writeFileSync(outputFile, "");
      runWithFakeGh(scriptPath("check_sub_issue_closure.ts"), [], {
        env: { GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile, CLOSED_NUM: "9", OWNER: "owner", REPO: "repo" },
        rules: [
          {
            match: ["graphql"],
            stdout: JSON.stringify({
              data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: 12 }] } } } },
            }),
          },
        ],
      });
      const out = parseGithubOutput(readFileSync(outputFile, "utf8"));
      expect(out.closed_via_pr).toBe("true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports is_sub_issue=false when there is no atoma:parent tag", () => {
    const dir = mkdtempSync(join(tmpdir(), "atoma-test-"));
    try {
      const eventFile = join(dir, "event.json");
      const outputFile = join(dir, "out");
      writeFileSync(eventFile, JSON.stringify({ issue: { body: "just a regular issue" } }));
      writeFileSync(outputFile, "");
      runWithFakeGh(scriptPath("check_sub_issue_closure.ts"), [], {
        env: { GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: outputFile, CLOSED_NUM: "9", OWNER: "owner", REPO: "repo" },
      });
      const out = parseGithubOutput(readFileSync(outputFile, "utf8"));
      expect(out.is_sub_issue).toBe("false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

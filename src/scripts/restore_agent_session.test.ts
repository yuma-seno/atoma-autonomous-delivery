import { describe, expect, test } from "bun:test";
import { findAgentSession } from "./restore_agent_session.ts";
import { nextArchiveSessionPath, sessionTargetPath } from "./lib/atoma-data.ts";

describe("restore_agent_session.ts", () => {
  test("uses context directories and allocates per-agent archive sequence numbers", () => {
    expect(sessionTargetPath("issue", 42, "engineer")).toBe("sessions/issue-42/engineer.json");
    expect(nextArchiveSessionPath("issue", 42, "engineer", [])).toBe("sessions/issue-42/archive/engineer-1.json");
    expect(nextArchiveSessionPath("issue", 42, "engineer", ["engineer-1.json", "reviewer-9.json", "engineer-3.json"]))
      .toBe("sessions/issue-42/archive/engineer-4.json");
  });

  test("restores only the canonical context-scoped session", () => {
    const sessions = new Map<string, string>();
    const load = (target: string) => sessions.get(target);

    expect(findAgentSession("issue", 5, "reviewer", load)).toEqual({
      target: "sessions/issue-5/reviewer.json",
      content: undefined,
    });

    sessions.set("sessions/issue-5/reviewer.json", "hierarchical-issue");
    expect(findAgentSession("issue", 5, "reviewer", load)).toEqual({
      target: "sessions/issue-5/reviewer.json",
      content: "hierarchical-issue",
    });
  });
});

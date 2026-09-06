import { describe, expect, test } from "bun:test";
import { mostRecentAgent } from "./resolve_resume_agent.ts";
import { AGENT_TAG } from "../lib/tags.ts";

const from = (agent: string) => `${AGENT_TAG.write(agent)}\nwork happened`;

describe("resolve_resume_agent.ts", () => {
  // An issue worked by an orchestrator and then an engineer must resume the
  // engineer. Reading in chronological order would resume whoever went first, for
  // the whole life of the issue.
  test("takes the agent from the most recent comment that names one", () => {
    expect(mostRecentAgent([from("orchestrator"), "a human comment", from("engineer")])).toBe("engineer");
  });

  test("skips comments that name no agent", () => {
    expect(mostRecentAgent([from("engineer"), "looks good to me", "+1"])).toBe("engineer");
  });

  test("finds nothing on an issue no agent has run on", () => {
    expect(mostRecentAgent(["please look at this", ""])).toBe("");
    expect(mostRecentAgent([])).toBe("");
  });
});

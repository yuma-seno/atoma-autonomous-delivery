import { describe, expect, test } from "bun:test";
import { resolveToolSecrets, TOOL_SECRET_SLOTS } from "./tool-secrets.ts";

describe("resolveToolSecrets", () => {
  test("no declaration is the normal case, not a problem", () => {
    for (const raw of [undefined, null, []]) {
      expect(resolveToolSecrets(raw)).toEqual({ names: [], problems: [] });
    }
  });

  test("keeps declared names in slot order", () => {
    const { names, problems } = resolveToolSecrets(["SLACK_TOKEN", "JIRA_API_TOKEN"]);
    expect(problems).toEqual([]);
    expect(names).toEqual(["SLACK_TOKEN", "JIRA_API_TOKEN"]);
  });

  test("tolerates surrounding whitespace", () => {
    expect(resolveToolSecrets(["  SLACK_TOKEN  "]).names).toEqual(["SLACK_TOKEN"]);
  });

  // Lowercase is rejected rather than normalised: GitHub would accept both
  // spellings as one secret, and this would read them as two declarations.
  test("rejects names that are not shaped like an environment variable", () => {
    for (const bad of ["slack_token", "1TOKEN", "SLACK-TOKEN", "SLACK TOKEN", ""]) {
      const { names, problems } = resolveToolSecrets([bad]);
      expect(names, bad).toEqual([]);
      expect(problems.length, bad).toBe(1);
    }
  });

  test("rejects non-strings", () => {
    const { names, problems } = resolveToolSecrets([42]);
    expect(names).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  // The whole point of the reserved list: this would have replaced the run's own
  // token with an adopter-supplied value instead of adding a credential.
  test("rejects a name the run already uses for itself", () => {
    for (const reserved of ["GH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ISSUE_NUMBER"]) {
      const { names, problems } = resolveToolSecrets([reserved]);
      expect(names, reserved).toEqual([]);
      expect(problems[0], reserved).toContain(reserved);
    }
  });

  test("rejects a name that collides with the internal slots", () => {
    expect(resolveToolSecrets(["ATOMA_TOOL_SECRET_0"]).problems).toHaveLength(1);
  });

  test("rejects a duplicate", () => {
    const { names, problems } = resolveToolSecrets(["SLACK_TOKEN", "SLACK_TOKEN"]);
    expect(names).toEqual([]);
    expect(problems[0]).toContain("more than once");
  });

  test("fills every slot but refuses one more", () => {
    const fits = Array.from({ length: TOOL_SECRET_SLOTS }, (_, i) => `TOKEN_${i}`);
    expect(resolveToolSecrets(fits).names).toHaveLength(TOOL_SECRET_SLOTS);

    const { names, problems } = resolveToolSecrets([...fits, "ONE_TOO_MANY"]);
    expect(names).toEqual([]);
    expect(problems[0]).toContain(String(TOOL_SECRET_SLOTS));
  });

  test("rejects a declaration that is not an array", () => {
    expect(resolveToolSecrets("SLACK_TOKEN").problems).toHaveLength(1);
  });

  // A partially applied list would give a tool server a runtime failure instead
  // of a configuration error, so one bad entry withholds all of them.
  test("reports every problem at once and returns no names", () => {
    const { names, problems } = resolveToolSecrets(["SLACK_TOKEN", "bad name", "GH_TOKEN"]);
    expect(names).toEqual([]);
    expect(problems).toHaveLength(2);
  });
});

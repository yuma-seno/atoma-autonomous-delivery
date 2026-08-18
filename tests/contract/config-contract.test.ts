import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveMergeGates } from "../../src/domain/merge-gates.ts";

describe("config.json", () => {
  test("is valid and matches expected shape", async () => {
    const c = await Bun.file("src/atoma/config.json").json();
    expect(c.agents.orchestrator.max_iterations).toBe(100);
    expect(c.merge_policy).toBe("auto");
    expect(c.labels).toBeDefined();
  });

  // Gates are the project's own conditions, so the template ships none. A
  // default `db/migrations/**` would be a guess about somebody else's repository,
  // and a wrong one would block their merges on day one.
  test("the shipped template declares no merge gates", async () => {
    const c = await Bun.file("src/atoma/config.json").json();
    expect(c.merge_gates).toBeUndefined();
    expect(resolveMergeGates(c.merge_gates)).toEqual({ gates: [], problems: [] });
  });
});

// The condition set and the table documenting it are joined by nothing but two
// people writing the same words. A condition added in code and left out of the
// docs is unfindable; one documented and never implemented is worse, because
// someone writes it, it is rejected as unknown, and the docs said it existed.
describe("merge_gates documentation", () => {
  const CONDITIONS = ["files_added", "files_removed", "files_modified", "files_changed", "labels", "title_matches"];

  test("every condition the code accepts appears in the customization guide", () => {
    const docs = readFileSync("docs/customization.md", "utf8");
    for (const condition of CONDITIONS) {
      expect(docs, `${condition} must be documented`).toContain(`\`${condition}\``);
    }
  });

  test("the code accepts every condition the guide documents", () => {
    // Read back through the resolver rather than against a second list: a
    // documented condition that the resolver rejects reports itself here.
    for (const condition of CONDITIONS) {
      const value = condition === "title_matches" ? "^x" : ["db/migrations/**"];
      const { gates, problems } = resolveMergeGates([{ reason: "r", when: { [condition]: value } }]);
      expect(problems, condition).toEqual([]);
      expect(gates, condition).toHaveLength(1);
    }
  });

  test("the reviewer knows what to do with the blockers a gate produces", () => {
    const reviewer = readFileSync("src/atoma/agent-definitions/reviewer.md", "utf8");
    for (const kind of ["merge-gate", "gate-config-invalid"]) {
      expect(reviewer, `${kind} must be in the reviewer's blocker table`).toContain(`\`${kind}\``);
    }
  });
});

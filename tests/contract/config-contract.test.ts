import { describe, expect, test } from "bun:test";

describe("config.json", () => {
  test("is valid and matches expected shape", async () => {
    const c = await Bun.file("src/atoma/config.json").json();
    expect(c.agents.orchestrator.max_iterations).toBe(100);
    expect(c.merge_policy).toBe("auto");
    expect(c.labels).toBeDefined();
  });
});

import { describe, expect, test } from "bun:test";
import {
  resolveDeployTargets,
  tagMatches,
  targetByName,
  targetsForMerge,
  targetsForTag,
  type DeployTarget,
} from "./deploy-targets.ts";

const staging = { name: "staging", on: "merge", commands: ["./deploy.sh staging"] };
const production = { name: "production", on: "tag", tags: ["v*"], commands: ["./deploy.sh prod"] };

describe("resolveDeployTargets", () => {
  test("no declaration is the normal case, not a problem", () => {
    for (const raw of [undefined, null, []]) {
      expect(resolveDeployTargets(raw)).toEqual({ targets: [], problems: [] });
    }
  });

  test("reads a merge target and a tag target", () => {
    const { targets, problems } = resolveDeployTargets([staging, production]);
    expect(problems).toEqual([]);
    expect(targets).toEqual([
      { name: "staging", on: "merge", tags: [], commands: ["./deploy.sh staging"] },
      { name: "production", on: "tag", tags: ["v*"], commands: ["./deploy.sh prod"] },
    ]);
  });

  test("rejects a name that is not dispatch-friendly", () => {
    for (const name of ["Production", "prod_1", "", "1prod"]) {
      expect(resolveDeployTargets([{ ...staging, name }]).problems, name).toHaveLength(1);
    }
  });

  test("rejects an unknown trigger", () => {
    expect(resolveDeployTargets([{ ...staging, on: "schedule" }]).problems[0]).toContain("`on`");
  });

  // Without a pattern this would fire on every tag in the repository — never
  // what anyone wrote, and expensive to discover from a surprise deployment.
  test("a tag target must say which tags", () => {
    const { problems } = resolveDeployTargets([{ name: "production", on: "tag", commands: ["x"] }]);
    expect(problems[0]).toContain("at least one pattern");
  });

  test("tags on a non-tag target is a mistake worth naming", () => {
    const { problems } = resolveDeployTargets([{ ...staging, tags: ["v*"] }]);
    expect(problems[0]).toContain("only applies to");
  });

  test("a target that runs nothing is a mistake", () => {
    expect(resolveDeployTargets([{ ...staging, commands: [] }]).problems[0]).toContain("no commands");
    expect(resolveDeployTargets([{ ...staging, commands: "./x.sh" }]).problems[0]).toContain("must be an array");
  });

  test("rejects a duplicate name", () => {
    expect(resolveDeployTargets([staging, staging]).problems[0]).toContain("more than once");
  });

  // A half-honoured list reports success having skipped the target that mattered.
  test("one bad target withholds all of them", () => {
    const { targets, problems } = resolveDeployTargets([staging, { ...production, on: "whenever" }]);
    expect(targets).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  test("manual targets are legal and carry no trigger of their own", () => {
    const { targets, problems } = resolveDeployTargets([{ name: "rollback", on: "manual", commands: ["./undo.sh"] }]);
    expect(problems).toEqual([]);
    expect(targets[0]?.on).toBe("manual");
  });
});

describe("selecting targets for an event", () => {
  const targets = resolveDeployTargets([
    staging,
    production,
    { name: "rollback", on: "manual", commands: ["./undo.sh"] },
    { name: "beta", on: "tag", tags: ["beta-1.0"], commands: ["./beta.sh"] },
  ]).targets as DeployTarget[];

  test("a merge deploys only the merge targets", () => {
    expect(targetsForMerge(targets).map((t) => t.name)).toEqual(["staging"]);
  });

  test("a tag deploys the targets whose pattern claims it", () => {
    expect(targetsForTag(targets, "refs/tags/v1.2.3").map((t) => t.name)).toEqual(["production"]);
    expect(targetsForTag(targets, "refs/tags/beta-1.0").map((t) => t.name)).toEqual(["beta"]);
  });

  test("a tag nobody asked for deploys nothing", () => {
    expect(targetsForTag(targets, "refs/tags/nightly-2026-08-17")).toEqual([]);
  });

  test("accepts a bare tag as well as a full ref", () => {
    expect(targetsForTag(targets, "v2.0.0").map((t) => t.name)).toEqual(["production"]);
  });

  test("a manual target is never triggered by an event", () => {
    expect(targetsForMerge(targets).some((t) => t.name === "rollback")).toBe(false);
    expect(targetsForTag(targets, "refs/tags/v1.0.0").some((t) => t.name === "rollback")).toBe(false);
  });

  test("dispatch finds a target by name, and invents nothing", () => {
    expect(targetByName(targets, "rollback")?.name).toBe("rollback");
    expect(targetByName(targets, "typo")).toBeUndefined();
  });
});

describe("tagMatches", () => {
  test("a prefix pattern claims what follows it", () => {
    expect(tagMatches("v*", "v1.0.0")).toBe(true);
    expect(tagMatches("v*", "release-1")).toBe(false);
  });

  test("a pattern without a wildcard matches that one tag", () => {
    expect(tagMatches("v1.0.0", "v1.0.0")).toBe(true);
    expect(tagMatches("v1.0.0", "v1.0.0-rc1")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  matchMergeGates,
  resolveMergeGates,
  type ChangedFile,
  type PullRequestFacts,
} from "./merge-gates.ts";

/** The declaration from the issue that asked for this. */
const MIGRATION_GATE = [
  {
    reason: "新しいマイグレーションを含むため、人間が確認してください",
    when: { files_added: ["db/migrations/**"] },
  },
];

function facts(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return { changedFiles: [], labels: [], title: "", ...overrides };
}

const file = (path: string, status: ChangedFile["status"]): ChangedFile => ({ path, status });

describe("resolveMergeGates", () => {
  test("no declaration is not a problem", () => {
    expect(resolveMergeGates(undefined)).toEqual({ gates: [], problems: [] });
    expect(resolveMergeGates(null)).toEqual({ gates: [], problems: [] });
  });

  test("reads the declaration the issue asked for", () => {
    const { gates, problems } = resolveMergeGates(MIGRATION_GATE);
    expect(problems).toEqual([]);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.reason).toBe("新しいマイグレーションを含むため、人間が確認してください");
    expect(gates[0]?.when.filesAdded).toEqual(["db/migrations/**"]);
    // Everything not named is not a condition, which is what lets one gate be
    // about exactly one thing.
    expect(gates[0]?.when.filesChanged).toEqual([]);
    expect(gates[0]?.when.titleMatches).toBe("");
  });

  test("a reason is required, because it is what a person reads", () => {
    const { problems } = resolveMergeGates([{ when: { files_added: ["db/**"] } }]);
    expect(problems.join(" ")).toContain("`reason`");
  });

  // The core decision of this module: silence is the failure mode. A gate that
  // matches nothing is indistinguishable from a gate nobody needed.
  test("a misspelled condition is an error, not a gate that never fires", () => {
    const { gates, problems } = resolveMergeGates([
      { reason: "x", when: { file_added: ["db/migrations/**"] } },
    ]);
    expect(gates).toEqual([]);
    expect(problems.join(" ")).toContain("file_added");
    expect(problems.join(" ")).toContain("matches nothing");
  });

  test("an unknown key on the gate itself is an error too", () => {
    const { problems } = resolveMergeGates([
      { reason: "x", when: { files_added: ["db/**"] }, run: "./gate.ts" },
    ]);
    expect(problems.join(" ")).toContain("`run`");
  });

  // A pattern form the matcher cannot honour would compare literally and claim
  // nothing, which is the same silent failure by another route.
  test("a wildcard the matcher cannot honour is rejected", () => {
    for (const pattern of ["**/*.sql", "db/*/migrations/**", "*.ts"]) {
      const { gates, problems } = resolveMergeGates([{ reason: "x", when: { files_added: [pattern] } }]);
      expect(gates, pattern).toEqual([]);
      expect(problems.join(" "), pattern).toContain("wildcard");
    }
  });

  test("a gate with no conditions would stop every merge, and is refused", () => {
    const { problems } = resolveMergeGates([{ reason: "everything", when: {} }]);
    expect(problems.join(" ")).toContain("merge_policy");
  });

  test("an empty condition list is a mistake rather than a no-op", () => {
    const { problems } = resolveMergeGates([{ reason: "x", when: { files_added: [] } }]);
    expect(problems.join(" ")).toContain("constrains nothing");
  });

  test("a title condition must compile", () => {
    const { problems } = resolveMergeGates([{ reason: "x", when: { title_matches: "([unclosed" } }]);
    expect(problems.join(" ")).toContain("not a valid regular expression");
  });

  // All or nothing, like `resolveDeployTargets`. A half-honoured list reports
  // that the gates ran while the one that mattered was dropped.
  test("one bad gate drops the whole list", () => {
    const { gates, problems } = resolveMergeGates([
      { reason: "good", when: { files_added: ["db/migrations/**"] } },
      { reason: "bad", when: { nope: ["x"] } },
    ]);
    expect(gates).toEqual([]);
    expect(problems).not.toEqual([]);
  });
});

describe("matchMergeGates", () => {
  const { gates } = resolveMergeGates(MIGRATION_GATE);

  test("an added migration applies the gate, and the reason is relayed as written", () => {
    const matches = matchMergeGates(
      gates,
      facts({ changedFiles: [file("db/migrations/003_add_users.sql", "added")] }),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.reason).toBe("新しいマイグレーションを含むため、人間が確認してください");
    expect(matches[0]?.evidence).toEqual(["db/migrations/003_add_users.sql"]);
  });

  // The whole reason `governed_paths` was not enough: editing an existing
  // migration is not adding one, and a path glob cannot tell them apart.
  test("editing an existing migration does not apply an added-only gate", () => {
    const matches = matchMergeGates(
      gates,
      facts({ changedFiles: [file("db/migrations/001_init.sql", "modified")] }),
    );
    expect(matches).toEqual([]);
  });

  test("ordinary work applies nothing", () => {
    expect(matchMergeGates(gates, facts({ changedFiles: [file("src/lib/config.ts", "modified")] }))).toEqual([]);
  });

  test("no gates declared means nothing applies", () => {
    expect(matchMergeGates([], facts({ changedFiles: [file("db/migrations/x.sql", "added")] }))).toEqual([]);
  });

  test("files_changed is the union, and covers what governed_paths would", () => {
    const { gates: any_change } = resolveMergeGates([
      { reason: "touched", when: { files_changed: ["db/migrations/**"] } },
    ]);
    for (const status of ["added", "removed", "modified"] as const) {
      expect(matchMergeGates(any_change, facts({ changedFiles: [file("db/migrations/x.sql", status)] })), status)
        .toHaveLength(1);
    }
  });

  test("a removal is its own condition", () => {
    const { gates: dropped } = resolveMergeGates([
      { reason: "a migration was deleted", when: { files_removed: ["db/migrations/**"] } },
    ]);
    expect(matchMergeGates(dropped, facts({ changedFiles: [file("db/migrations/x.sql", "removed")] }))).toHaveLength(1);
    expect(matchMergeGates(dropped, facts({ changedFiles: [file("db/migrations/x.sql", "added")] }))).toEqual([]);
  });

  test("conditions within one gate must all hold", () => {
    const { gates: both } = resolveMergeGates([
      { reason: "labelled schema change", when: { files_added: ["db/migrations/**"], labels: ["schema"] } },
    ]);
    const added = [file("db/migrations/x.sql", "added")];
    expect(matchMergeGates(both, facts({ changedFiles: added, labels: ["schema"] }))).toHaveLength(1);
    expect(matchMergeGates(both, facts({ changedFiles: added, labels: ["chore"] }))).toEqual([]);
    expect(matchMergeGates(both, facts({ labels: ["schema"] }))).toEqual([]);
  });

  test("separate gates are independent situations", () => {
    const { gates: two } = resolveMergeGates([
      { reason: "migration", when: { files_added: ["db/migrations/**"] } },
      { reason: "breaking", when: { title_matches: "^BREAKING" } },
    ]);
    const matches = matchMergeGates(
      two,
      facts({ changedFiles: [file("db/migrations/x.sql", "added")], title: "BREAKING: drop v1" }),
    );
    expect(matches.map((m) => m.reason)).toEqual(["migration", "breaking"]);
  });

  test("a title condition is case-insensitive and names itself in the evidence", () => {
    const { gates: titled } = resolveMergeGates([{ reason: "x", when: { title_matches: "breaking" } }]);
    const matches = matchMergeGates(titled, facts({ title: "BREAKING change" }));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.evidence).toEqual(["title:BREAKING change"]);
  });

  test("a literal pattern claims that one file and not its neighbours", () => {
    const { gates: literal } = resolveMergeGates([
      { reason: "x", when: { files_modified: ["package.json"] } },
    ]);
    expect(matchMergeGates(literal, facts({ changedFiles: [file("package.json", "modified")] }))).toHaveLength(1);
    expect(matchMergeGates(literal, facts({ changedFiles: [file("web/package.json", "modified")] }))).toEqual([]);
  });
});

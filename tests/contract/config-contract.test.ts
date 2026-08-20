import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { configProblems, knownConfigKeys } from "../../src/domain/deliverable-integrity.ts";
import { CONDITION_KEYS, resolveMergeGates } from "../../src/domain/merge-gates.ts";

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
  // The resolver's own list, not a copy of it. A copy meant adding a condition and
  // forgetting this array left it undocumented while both tests below still passed.
  const CONDITIONS = CONDITION_KEYS;

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

/**
 * config.json's recognised keys, in the type and at run time.
 *
 * `AtomaConfig` in `lib/types.ts` is the definition and `CONFIG_SCHEMA` in
 * `domain/deliverable-integrity.ts` is the runtime mirror, because an interface is
 * erased before anything can consult it. Two lists of the same fact — which is
 * exactly what `validate_deliverable.ts` exists to catch in an adopter's config, so
 * it had better not be uncheckable here.
 *
 * The interface is the authority, and this reads it with TypeScript's own parser
 * rather than with a regular expression. A regex was tried and is not good enough:
 * the nested members are indented inconsistently in that file (one is at five
 * spaces), `Record<string, {...}>` has to be understood rather than matched, and an
 * index signature means something specific — any name is legal here — that a line
 * pattern cannot distinguish from a property.
 *
 * Drift in either direction is a real failure. A key added to the type and not to
 * the schema is reported to an adopter as a typo, for a setting the code reads. One
 * added to the schema and not the type is accepted and read by nothing.
 */
describe("config.json's recognised keys", () => {
  /** `Record<string, X>`'s value type, or undefined when `type` is not one. */
  function recordValueType(type: ts.TypeNode | undefined, source: ts.SourceFile): ts.TypeNode | undefined {
    if (!type || !ts.isTypeReferenceNode(type)) return undefined;
    if (type.typeName.getText(source) !== "Record") return undefined;
    return type.typeArguments?.[1];
  }

  /** Dotted paths under `path`, with `*` for a level where any name is legal. */
  function descend(type: ts.TypeNode | undefined, path: string, source: ts.SourceFile, out: string[]): void {
    if (!type) return;
    if (ts.isTypeLiteralNode(type)) {
      if (type.members.some((member) => ts.isIndexSignatureDeclaration(member))) out.push(`${path}.*`);
      for (const member of type.members) {
        if (!ts.isPropertySignature(member) || !member.name) continue;
        const child = `${path}.${member.name.getText(source)}`;
        out.push(child);
        descend(member.type, child, source, out);
      }
      return;
    }
    const value = recordValueType(type, source);
    if (value) {
      out.push(`${path}.*`);
      descend(value, `${path}.*`, source, out);
    }
  }

  function keysFromTheInterface(): string[] {
    const file = "src/lib/types.ts";
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "AtomaConfig",
    );
    expect(declaration, "AtomaConfig is no longer an interface in src/lib/types.ts").toBeDefined();

    const out: string[] = [];
    for (const member of declaration!.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const name = member.name.getText(source);
      out.push(name);
      descend(member.type, name, source, out);
    }
    return out.sort();
  }

  test("the runtime schema and the interface name the same keys", () => {
    expect(knownConfigKeys()).toEqual(keysFromTheInterface());
  });

  /**
   * The keys a person can actually set: the leaves of the schema, minus the levels
   * where any name is legal.
   *
   * A parent is not settable on its own — writing `"checks": {}` configures nothing
   * — and `labels.*` is not a key at all, it is permission to invent one. So
   * neither belongs in a list an adopter reads.
   */
  function settableKeys(): string[] {
    const all = knownConfigKeys();
    return all
      .filter((key) => !all.some((other) => other.startsWith(`${key}.`)))
      .filter((key) => !key.endsWith("*"))
      .sort();
  }

  /** The first backticked token of each bullet in the `config.json` contract section. */
  function documentedKeys(): string[] {
    const docs = readFileSync("docs/customization.md", "utf8").replace(/\r\n/g, "\n");
    const start = docs.indexOf("## `config.json` contract");
    expect(start, "the config.json contract section is gone from docs/customization.md").toBeGreaterThan(-1);
    // Bounded at the next heading of any level: the subsections after it carry
    // bullet lists of their own, and those are not config keys.
    const offset = docs.slice(start + 1).search(/\n#{2,3} /);
    const section = docs.slice(start, offset === -1 ? undefined : start + 1 + offset);

    const keys: string[] = [];
    for (const line of section.split("\n")) {
      const match = /^- `([^`]+)`/.exec(line);
      // `<name>` is how the docs write a level where any name is legal, and `*` is
      // how the schema writes it. One bullet, one key: a bullet may go on to
      // mention the fields an entry takes, and those are not top-level keys.
      if (match?.[1]) keys.push(match[1].replace("<name>", "*"));
    }
    return keys.sort();
  }

  /**
   * The list an adopter writes config.json from, held to the schema that judges it.
   *
   * A fourth copy of the same fact lived here — the interface, the runtime schema,
   * the readers in `lib/config.ts`, and this list — and the drift is worse than
   * useless in one specific direction: a key documented but not read is one an
   * adopter writes, and `validate_deliverable.ts` then fails their pull request for
   * following the documentation.
   */
  test("the customization guide lists every settable key, and no others", () => {
    expect(documentedKeys()).toEqual(settableKeys());
  });

  // The walk above finds nothing if the interface is renamed or the file moves, and
  // an empty list would compare equal to an empty schema.
  test("the walk found something", () => {
    expect(keysFromTheInterface().length).toBeGreaterThan(10);
  });

  // Every key the shipped config sets has to be one the schema recognises, or the
  // template validates as broken on the first adoption.
  test("the shipped config.json declares only recognised keys", async () => {
    const config = await Bun.file("src/atoma/config.json").json();
    expect(
      configProblems({
        config,
        agentNames: readdirSync("src/atoma/agent-definitions")
          .filter((file) => file.endsWith(".md"))
          .map((file) => file.slice(0, -".md".length)),
        workflowFiles: readdirSync("dist/.github/workflows"),
      }),
    ).toEqual([]);
  });
});

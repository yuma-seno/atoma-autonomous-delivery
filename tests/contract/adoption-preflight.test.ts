/**
 * adoption-preflight.test.ts — the README's preflight checklist, held to the
 * configuration it is a checklist for.
 *
 * This is the one document where being wrong costs the most. It is what someone
 * reads before their first run, and it had drifted into naming a credential the
 * shipped configuration does not use: `OPENAI_API_KEY`, while all three agent
 * definitions read `provider: openrouter-responses`. Since atoma v0.1.13 one
 * provider reads one credential with **no fallback**, so every new adopter
 * following the checklist got a failed first run, on the run that is supposed to
 * prove the adoption worked.
 *
 * ## Where the truth lives
 *
 * The provider table in `docs/customization.md` is the mapping, and this test
 * reads it rather than restating it — so there is no third copy to drift. The
 * chain is: agent definition names a provider, the table says which credential
 * that provider reads, the README must name that credential.
 *
 * The core is authoritative above all of this: the table itself mirrors
 * `PROVIDERS` in atoma's `infra/llm/mod.rs`, and a provider name that atoma does
 * not know is what `atoma validate` should reject (yuma-seno/atoma#9). This test
 * covers the half that lives here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR = "src/atoma/agent-definitions";

/** `provider:` from an agent definition's frontmatter. */
function providerOf(file: string): string | undefined {
  const lines = readFileSync(join(AGENT_DIR, file), "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = /^provider:\s*(\S+)\s*$/.exec(line);
    if (match?.[1]) return match[1];
    if (line === "---" && lines.indexOf(line) > 0) break; // end of frontmatter
  }
  return undefined;
}

/**
 * The provider -> credential mapping, read out of the customization guide's table.
 *
 * Rows look like: `| \`openrouter-responses\` | Responses | \`OPENROUTER_API_KEY\` | ... |`
 */
function credentialByProvider(): Map<string, string> {
  const docs = readFileSync("docs/customization.md", "utf8");
  const map = new Map<string, string>();
  for (const line of docs.split(/\r?\n/)) {
    const match = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|[^|]*\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line);
    if (match?.[1] && match[2]) map.set(match[1], match[2]);
  }
  return map;
}

/** The "Required before first run" list, which is the part a first run depends on. */
function preflightSection(): string {
  const readme = readFileSync("README.md", "utf8").replace(/\r\n/g, "\n");
  const start = readme.indexOf("## Preflight checklist");
  expect(start, "the preflight checklist is gone from README.md").toBeGreaterThan(-1);
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

const agentFiles = readdirSync(AGENT_DIR).filter((file) => file.endsWith(".md"));

describe("the preflight checklist", () => {
  test("the provider table was found and is not empty", () => {
    // Both readers below are regexes over prose. If either quietly matches
    // nothing, every assertion after it passes without checking anything.
    expect(credentialByProvider().size).toBeGreaterThan(4);
    expect(agentFiles.length).toBeGreaterThan(0);
  });

  test("every shipped agent's provider appears in the customization guide", () => {
    const table = credentialByProvider();
    for (const file of agentFiles) {
      const provider = providerOf(file);
      expect(provider, `${file} declares no provider`).toBeDefined();
      expect(
        table.has(provider!),
        `${file} uses provider '${provider}', which the guide's table does not list. ` +
          `Listed: ${[...table.keys()].sort().join(", ")}`,
      ).toBe(true);
    }
  });

  test("the README names the credential the shipped configuration needs", () => {
    const table = credentialByProvider();
    const preflight = preflightSection();
    for (const file of agentFiles) {
      const credential = table.get(providerOf(file)!);
      expect(
        preflight.includes(credential!),
        `${file} runs on ${providerOf(file)}, which authenticates with ${credential} — ` +
          `and the preflight checklist does not name it. A first run cannot start.`,
      ).toBe(true);
    }
  });

  /**
   * The inverse, and the direction the drift actually went: the checklist named
   * `OPENAI_API_KEY` long after nothing shipped used it. A credential named as
   * required, that nothing reads, sends an adopter to create a secret that does
   * not help and then to debug a failure the checklist caused.
   */
  test("the README requires no credential the shipped configuration does not use", () => {
    const needed = new Set(agentFiles.map((file) => credentialByProvider().get(providerOf(file)!)));
    const preflight = preflightSection();
    // Only the "Required before first run" bullets, not the prose that explains
    // how to move to another provider — naming the alternatives there is the point.
    const required = preflight.slice(0, preflight.indexOf("To run somewhere else"));
    for (const credential of [...credentialByProvider().values()]) {
      if (needed.has(credential)) continue;
      expect(
        required.includes(credential),
        `the checklist requires ${credential}, which no shipped agent definition uses`,
      ).toBe(false);
    }
  });
});

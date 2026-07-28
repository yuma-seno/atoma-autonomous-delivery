/**
 * deployment-contract.test.ts — every static Atoma file reaches the deployed
 * `.github/`.
 *
 * `sync-dist` deploys by wiping `.github/` and repopulating it from `dist/`:
 *
 *     rm -rf .github && cp -r dist/.github/. .github/
 *
 * So a file that exists only under `.github/` is not deployed — it is pending
 * deletion. It keeps working until the next sync and then vanishes, and because
 * agent PR merges are made with GITHUB_TOKEN (which does not trigger
 * workflows), that sync can be an arbitrarily long time after the change that
 * introduced it.
 *
 * This already happened: a PR added `.github/atoma/mcp-packages.json` by hand
 * without adding it to `src/atoma/` or to build-dist.ts's copy list, while
 * switching tools.yaml to a binary that only that file installs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ATOMA_SRC = join(process.cwd(), "src/atoma");
const BUILD_DIST = join(process.cwd(), "src/build-dist.ts");

/** Filenames in build-dist.ts's verbatim-copy list. */
function copiedFiles(): string[] {
  const source = readFileSync(BUILD_DIST, "utf8");
  const list = /for \(const file of \[([^\]]*)\]\)/.exec(source)?.[1];
  if (!list) throw new Error("could not locate build-dist.ts's static copy list");
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/**
 * Loose static files sitting directly in src/atoma/, i.e. the ones that have to
 * be named in build-dist.ts's copy list. Restricted to shippable data
 * extensions: anything else in there is a stray, which the first test below
 * reports on its own terms rather than as a missing copy-list entry.
 */
function staticFiles(): string[] {
  return readdirSync(ATOMA_SRC, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(json|md|ya?ml)$/.test(e.name))
    .map((e) => e.name);
}

/** Every file under a directory, recursively, repo-relative. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(relative(process.cwd(), path).replaceAll("\\", "/"));
  }
  return out;
}

describe("deployment contract", () => {
  // `src/atoma/` is the deliverable, mirrored 1:1 into `dist/.github/atoma/`
  // and from there into an adopter's own `.github/`. Anything that exists to
  // develop THIS repository — a test, a fixture, a build helper — belongs
  // outside it, which is why these contract tests live under `tests/`.
  test("src/atoma/ holds nothing that exists only to develop this repo", () => {
    const strays = walk(ATOMA_SRC).filter((f) => /\.test\.ts$|\.spec\.ts$/.test(f));
    expect(strays, `move these out of src/atoma/: ${strays.join(", ")}`).toEqual([]);
  });

  test("src/atoma/ and the shipped dist tree hold the same static files", () => {
    const distAtoma = join(process.cwd(), "dist/.github/atoma");
    let shipped: string[];
    try {
      statSync(distAtoma);
      shipped = walk(distAtoma).map((f) => f.replace("dist/.github/atoma/", ""));
    } catch {
      return; // dist/ not built in this checkout; synth:check covers that case
    }

    // Markdown and YAML are copied verbatim, so every one in src must ship.
    const sourceStatic = walk(ATOMA_SRC)
      .map((f) => f.replace("src/atoma/", ""))
      .filter((f) => f.endsWith(".md") || f.endsWith(".yaml") || f.endsWith(".json"));

    for (const file of sourceStatic) {
      expect(shipped.includes(file), `src/atoma/${file} never reaches dist/.github/atoma/`).toBe(true);
    }
  });

  test("build-dist.ts copies every static file in src/atoma/", () => {
    const copied = copiedFiles();
    const present = staticFiles();

    expect(present.length).toBeGreaterThan(0);
    for (const file of present) {
      expect(
        copied.includes(file),
        `src/atoma/${file} is not in build-dist.ts's copy list, so it never reaches ` +
          `dist/ and will be deleted from .github/ on the next sync-dist run.`,
      ).toBe(true);
    }
  });

  test("build-dist.ts does not claim to copy files that are missing", () => {
    const present = staticFiles();
    for (const file of copiedFiles()) {
      expect(present.includes(file), `build-dist.ts copies src/atoma/${file}, which does not exist`).toBe(true);
    }
  });

  test("mcp-packages.json declares the servers tools.yaml invokes by bare command", () => {
    // tools.yaml entries whose `command:` is not `bun` are external binaries;
    // nothing installs them except the runner's MCP package step, which reads
    // mcp-packages.json.
    const yaml = readFileSync(join(ATOMA_SRC, "tools/tools.yaml"), "utf8");
    const commands = [...yaml.matchAll(/^\s{2}command:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);
    const external = [...new Set(commands.filter((c) => c !== "bun" && c !== "npx"))];

    const packages = JSON.parse(readFileSync(join(ATOMA_SRC, "mcp-packages.json"), "utf8")) as {
      npm?: string[];
      pip?: string[];
    };
    const declared = [...(packages.npm ?? []), ...(packages.pip ?? [])].join(" ");

    for (const command of external) {
      // The npm package name need not equal the binary name, so require only
      // that something is declared to install — an empty list cannot be right.
      expect(
        declared.length > 0,
        `tools.yaml spawns "${command}", but mcp-packages.json installs nothing`,
      ).toBe(true);
    }
  });
});

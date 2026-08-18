import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EXAMPLES_DIR = "examples/workflows";

/**
 * `examples/` is for the adopter to copy, and must never become deliverable.
 *
 * The whole point of the recurring-work example is that Atoma does not install
 * it: `on:` takes no expression, so a schedule cannot come from configuration,
 * and an agent cannot write `.github/workflows/**` at all. If one of these files
 * ever reached `dist/.github/workflows/`, every adopter would start running a
 * schedule nobody asked for -- and the one whose cron fires an agent run would
 * be paying for it.
 *
 * Nothing in `build-dist.ts` or `wac.config.ts` looks at `examples/` today. This
 * is here so that stays true, since the failure is silent and arrives by upgrade.
 */
describe("examples are examples", () => {
  const examples = readdirSync(EXAMPLES_DIR);

  test("there is something to check", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  test("none of them is generated into the deliverable", () => {
    const distWorkflows = "dist/.github/workflows";
    const shipped = existsSync(distWorkflows) ? readdirSync(distWorkflows) : [];
    for (const example of examples) {
      expect(shipped, `${example} must not be deployed`).not.toContain(example);
    }
  });

  // A `.wac.ts` file WOULD be generated -- `gwf build` collects them by
  // extension. Plain YAML is what keeps these out of the deliverable, so the
  // extension is load-bearing rather than a style choice.
  test("none of them is a workflow source file", () => {
    for (const example of examples) {
      expect(example.endsWith(".wac.ts"), example).toBe(false);
      expect(example.endsWith(".yml") || example.endsWith(".yaml"), example).toBe(true);
    }
  });

  // The step that hands the issue to an agent is the one thing a reader is most
  // likely to drop as boilerplate, and dropping it is silent: the issue appears
  // and nothing ever picks it up, because GitHub raises no `issues: opened`
  // event for an issue its own token created.
  test("the scheduled example dispatches the runner explicitly", () => {
    const yaml = readFileSync(join(EXAMPLES_DIR, "scheduled-issue.yml"), "utf8");
    expect(yaml).toContain("gh workflow run atoma-runner.yml");
    expect(yaml).toContain("issues: write");
    // And it does not create a second issue while the first is still open.
    expect(yaml).toContain("--state open");
  });

  // No heredocs in an example meant to be copied.
  //
  // A heredoc's terminator has to match its line exactly. This file is checked
  // out with CRLF on Windows, and someone copying it into their own repository
  // carries that through -- at which point the runner's bash looks for `BODY`,
  // reads `BODY`, never ends the document, and fails somewhere that looks
  // nothing like the cause. Multi-line text goes in a YAML block scalar instead,
  // which has no terminator to mismatch.
  test("the examples carry no heredoc, which CRLF would break", () => {
    for (const example of examples) {
      const yaml = readFileSync(join(EXAMPLES_DIR, example), "utf8");
      expect(yaml, example).not.toContain("<<'");
      expect(yaml, example).not.toContain("<<\"");
    }
  });
});

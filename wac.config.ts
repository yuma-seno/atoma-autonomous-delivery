import { defineConfig } from "@github-actions-workflow-ts/cli";

export default defineConfig({
  refs: false,
  headerText: [
    "# AUTO-GENERATED FILE -- DO NOT EDIT DIRECTLY.",
    "# Source of truth: <source-file-path>",
    "# Regenerate with: bun run synth",
    "",
  ],
  dumpOptions: {
    lineWidth: -1,
    styles: {
      "!!str": "literal",
    },
  },
  outputPaths: {
    workflows: {
      // All *.wac.ts files are the Atoma deliverable, copied into a user's
      // own .github/ -- this repo's own CI (.github/workflows/ci.yml) is
      // hand-written YAML, not generated, so no override is needed here.
      default: "dist/.github/workflows",
    },
  },
});


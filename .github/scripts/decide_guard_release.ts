#!/usr/bin/env bun
// @bun

// src/scripts/decide_guard_release.ts
import { appendFileSync } from "fs";
import { parseArgs } from "util";

// src/domain/serialization-guard.ts
function shouldReleaseGuard(signals) {
  if (!signals.succeeded)
    return true;
  if (signals.maxIterationsReached)
    return true;
  if (signals.loopLimitReached)
    return true;
  return !signals.chainContinues && signals.directive === "";
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/decide_guard_release.ts
var ref = defineScript(import.meta.url);
function isTrue(v) {
  return v === "true";
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      outcome: { type: "string" },
      "max-iterations-reached": { type: "string" },
      "loop-limit-reached": { type: "string" },
      "chain-continues": { type: "string" },
      directive: { type: "string" }
    }
  });
  if (!values.outcome) {
    console.error("decide_guard_release: --outcome missing/empty -- treating as non-success (releases the guard)");
  }
  const release = shouldReleaseGuard({
    succeeded: values.outcome === "success",
    maxIterationsReached: isTrue(values["max-iterations-reached"]),
    loopLimitReached: isTrue(values["loop-limit-reached"]),
    chainContinues: isTrue(values["chain-continues"]),
    directive: values.directive ?? ""
  });
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `should_release=${release}
`);
  }
  console.error(`decide_guard_release: outcome=${values.outcome ?? "(missing)"} -> should_release=${release}`);
}
if (import.meta.main)
  main();
export {
  ref
};

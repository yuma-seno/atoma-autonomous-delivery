#!/usr/bin/env bun
// @bun

// src/scripts/manage_dispatch_loop.ts
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import { parseArgs } from "util";

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/manage_dispatch_loop.ts
var ref = defineScript(import.meta.url);
var LOOP_LIMIT = 5;
function manageDispatchLoop(session, newEventCount, directive) {
  const metadata = typeof session.metadata === "object" && session.metadata !== null ? session.metadata : {};
  const githubContext = typeof metadata.github_context === "object" && metadata.github_context !== null ? metadata.github_context : {};
  let autoDispatchCount;
  if (newEventCount !== 0) {
    autoDispatchCount = 0;
  } else {
    autoDispatchCount = Number(githubContext.auto_dispatch_count ?? 0);
    if (directive)
      autoDispatchCount += 1;
  }
  const loopLimitReached = autoDispatchCount >= LOOP_LIMIT;
  githubContext.auto_dispatch_count = autoDispatchCount;
  metadata.github_context = githubContext;
  session.metadata = metadata;
  return { session, autoDispatchCount, loopLimitReached };
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      session: { type: "string" },
      "new-event-count": { type: "string" },
      directive: { type: "string" }
    }
  });
  if (!values.session) {
    console.error("usage: manage_dispatch_loop.ts --session session.json [--new-event-count N] [--directive NAME]");
    process.exit(2);
  }
  const session = JSON.parse(readFileSync(values.session, "utf8"));
  const {
    session: updated,
    autoDispatchCount,
    loopLimitReached
  } = manageDispatchLoop(session, Number(values["new-event-count"] ?? 0), values.directive ?? "");
  writeFileSync(values.session, JSON.stringify(updated, null, 2) + `
`);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `auto_dispatch_count=${autoDispatchCount}
loop_limit_reached=${loopLimitReached}
`);
  }
  console.error(`Auto-dispatch loop count: ${autoDispatchCount}/${LOOP_LIMIT} (limit_reached=${loopLimitReached})`);
}
if (import.meta.main)
  main();
export {
  ref,
  manageDispatchLoop
};

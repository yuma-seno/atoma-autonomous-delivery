#!/usr/bin/env bun
// @bun

// src/scripts/restore_agent_session.ts
import { writeFileSync } from "fs";
import { parseArgs } from "util";

// src/lib/gh.ts
function run(cmd) {
  const proc = Bun.spawnSync({
    cmd,
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout ? proc.stdout.toString("utf8").trim() : "",
    stderr: proc.stderr ? proc.stderr.toString("utf8").trim() : ""
  };
}
function gitRun(...args) {
  return run(["git", ...args]);
}

// src/scripts/lib/atoma-data.ts
function sessionTargetPath(type, number, agent) {
  return `sessions/${type}-${number}-${agent}.json`;
}
function restoreSession(targetPath) {
  if (gitRun("fetch", "origin", "atoma-data", "--depth=1").code !== 0) {
    return;
  }
  if (gitRun("cat-file", "-e", `origin/atoma-data:${targetPath}`).code !== 0) {
    return;
  }
  const shown = gitRun("show", `origin/atoma-data:${targetPath}`);
  return shown.code === 0 ? shown.stdout : undefined;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/restore_agent_session.ts
var ref = defineScript(import.meta.url);
function findAgentSession(type, number, agent, fallbackType, fallbackNumber, load = restoreSession) {
  const target = sessionTargetPath(type, number, agent);
  const content = load(target);
  if (content !== undefined)
    return { target, content };
  if (fallbackType && fallbackNumber !== undefined && (fallbackType !== type || String(fallbackNumber) !== String(number))) {
    const fallbackTarget = sessionTargetPath(fallbackType, fallbackNumber, agent);
    return { target: fallbackTarget, content: load(fallbackTarget) };
  }
  return { target };
}
function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      type: { type: "string" },
      number: { type: "string" },
      agent: { type: "string" },
      out: { type: "string" },
      "fallback-type": { type: "string" },
      "fallback-number": { type: "string" }
    }
  });
  if (!values.type || !values.number || !values.agent || !values.out) {
    console.error("usage: restore_agent_session.ts --type issue|pr --number N --agent NAME --out session.json");
    process.exit(2);
  }
  const { target, content } = findAgentSession(values.type, values.number, values.agent, values["fallback-type"], values["fallback-number"]);
  if (content !== undefined) {
    writeFileSync(values.out, content);
    console.error(`Restored session: ${target}`);
  } else {
    console.error(`No existing session at ${target}, starting fresh.`);
  }
}
if (import.meta.main)
  main();
export {
  ref,
  findAgentSession
};

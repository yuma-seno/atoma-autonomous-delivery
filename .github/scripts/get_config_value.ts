#!/usr/bin/env bun
// @bun

// src/lib/config.ts
import { readFileSync } from "fs";

// src/domain/merge-readiness.ts
var PASSING = new Set(["success", "neutral", "skipped"]);

// src/lib/config.ts
function configPath() {
  const root = process.env.ATOMA_MACHINERY_ROOT?.trim();
  return root ? `${root}/.github/atoma/config.json` : ".github/atoma/config.json";
}
var cached;
function loadConfig() {
  if (!cached) {
    cached = JSON.parse(readFileSync(configPath(), "utf8"));
  }
  return cached;
}

// src/scripts/lib/script-ref.ts
import { basename } from "path";
import { fileURLToPath } from "url";
var SCRIPTS_RUNTIME_ROOT = ".github/scripts";
function defineScript(importMetaUrl) {
  return { runtimePath: `${SCRIPTS_RUNTIME_ROOT}/${basename(fileURLToPath(importMetaUrl))}` };
}

// src/scripts/get_config_value.ts
var ref = defineScript(import.meta.url);
function buildArgv(path, fallback) {
  return fallback === undefined ? [`"${path}"`] : [`"${path}"`, `"${fallback}"`];
}
function main() {
  const [path, fallback = ""] = Bun.argv.slice(2);
  if (!path) {
    console.error("usage: get_config_value.ts <dotted.path> [default]");
    process.exit(2);
  }
  let node = loadConfig();
  for (const key of path.split(".")) {
    if (node && typeof node === "object" && key in node) {
      node = node[key];
    } else {
      console.log(fallback);
      return;
    }
  }
  console.log(node);
}
if (import.meta.main)
  main();
export {
  ref,
  buildArgv
};

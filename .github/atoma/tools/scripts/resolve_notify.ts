#!/usr/bin/env bun
/**
 * resolve_notify.ts — Resolve who to notify (a GitHub login) for a given
 * issue or PR.
 *
 * Looks for an `<!-- atoma:notify=LOGIN -->` tag in the body -- embedded by
 * mcp/github.ts when the agent that created the issue/PR knew
 * who the original human requester was.
 *
 * Falls back to the issue/PR's own author when no tag is present and the
 * author is a human. If neither is available, walks up the
 * `atoma:parent=#N` / `atoma:parent-issue=N` chain and retries on the
 * parent, since every sub-issue/PR is ultimately rooted in an issue a human
 * opened directly. Gives up after MAX_HOPS to guard against cycles.
 *
 * Usage:
 *   resolve_notify.ts --repo OWNER/REPO --number N
 *
 * Prints the resolved login (possibly empty) to stdout. Never throws for
 * missing data -- callers treat an empty result as "nobody to notify".
 */
import { parseArgs } from "node:util";
import { gh } from "./lib/gh.ts";

/** CLI contract for this script, used by callers (e.g. src/workflows/*.wac.ts) to build a type-checked argv. */
export interface ResolveNotifyArgs {
  repo: string;
  number: string | number;
}

const NOTIFY_RE = /<!--\s*atoma:notify=([A-Za-z0-9-]+)\s*-->/;
const PARENT_RE = /<!--\s*atoma:parent(?:-issue)?=#?(\d+)\s*-->/;
const MAX_HOPS = 10;

interface IssueLookup {
  body?: string;
  login?: string;
  type?: string;
}

function fetch(repo: string, number: number): IssueLookup {
  const { code, stdout } = gh(
    "api", `repos/${repo}/issues/${number}`,
    "--jq", "{body: .body, login: .user.login, type: .user.type}",
  );
  if (code !== 0 || !stdout.trim()) return {};
  try {
    return JSON.parse(stdout) as IssueLookup;
  } catch {
    return {};
  }
}

function resolve(repo: string, number: number): string {
  const visited = new Set<number>();
  let current = number;
  for (let i = 0; i < MAX_HOPS; i++) {
    if (visited.has(current)) break; // cycle guard
    visited.add(current);

    const d = fetch(repo, current);
    const body = d.body ?? "";

    const match = NOTIFY_RE.exec(body);
    if (match) return match[1]!;

    if ((d.type ?? "").toLowerCase() === "user" && d.login) {
      return d.login;
    }

    const parentMatch = PARENT_RE.exec(body);
    if (!parentMatch) break;
    current = Number(parentMatch[1]);
  }
  return "";
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      number: { type: "string" },
    },
  });

  if (!values.repo || !values.number) {
    console.error("usage: resolve_notify.ts --repo OWNER/REPO --number N");
    process.exit(2);
  }

  console.log(resolve(values.repo, Number(values.number)));
}

if (import.meta.main) main();

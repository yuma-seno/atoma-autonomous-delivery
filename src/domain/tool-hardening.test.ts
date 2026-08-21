/**
 * tool-hardening.test.ts — which PATH entries a credential-holding server drops.
 *
 * The rule is "drop what is writable", not "replace PATH with a known-good list",
 * and the difference is the point: a project whose `environment.setup_commands`
 * put a tool somewhere unusual keeps it, and only the entries that let a peer
 * plant a binary go.
 */
import { describe, expect, test } from "bun:test";
import { classifyPathEntries, pathWithoutWorldWritable } from "./tool-hardening.ts";

// The three measured on `ubuntu-latest`, all `drwxrwxrwx`.
const WRITABLE = new Set(["/opt/pipx_bin", "/usr/local/.ghcup/bin", "/usr/local/bin"]);
const isWorldWritable = (dir: string) => WRITABLE.has(dir);

describe("pathWithoutWorldWritable", () => {
  test("drops the writable entries and keeps the order of the rest", () => {
    const path = "/usr/local/bin:/usr/bin:/opt/pipx_bin:/bin:/home/runner/.bun/bin";
    expect(pathWithoutWorldWritable(path, isWorldWritable)).toBe("/usr/bin:/bin:/home/runner/.bun/bin");
  });

  // A project's own toolchain directory is not writable by the peer and has to
  // survive: replacing PATH with a fixed list would have removed it, and the
  // failure would surface as "command not found" inside a server.
  test("keeps a directory this file has never heard of", () => {
    expect(pathWithoutWorldWritable("/opt/my-toolchain/bin:/usr/bin", isWorldWritable)).toBe(
      "/opt/my-toolchain/bin:/usr/bin",
    );
  });

  // An empty element in PATH means the current directory, and a tool server's
  // current directory is the work tree -- which the agent writes.
  test("drops empty entries and an explicit dot", () => {
    expect(pathWithoutWorldWritable("/usr/bin::/bin", isWorldWritable)).toBe("/usr/bin:/bin");
    expect(pathWithoutWorldWritable("/usr/bin:.:/bin", isWorldWritable)).toBe("/usr/bin:/bin");
  });

  test("a PATH with nothing writable is returned unchanged", () => {
    expect(pathWithoutWorldWritable("/usr/bin:/bin", isWorldWritable)).toBe("/usr/bin:/bin");
  });
});

/**
 * The two reasons an entry is dropped, kept apart.
 *
 * The first real run of the hardening logged four directories as "writable" that
 * it had only failed to stat -- `node_modules/.bin` paths that do not exist, and
 * one whose parent the tool user cannot traverse. Both are dropped, and only one
 * is a security finding.
 */
describe("classifyPathEntries", () => {
  const inspect = (dir: string): "writable" | "safe" | "unreadable" => {
    if (WRITABLE.has(dir)) return "writable";
    if (dir.includes("does-not-exist")) return "unreadable";
    return "safe";
  };

  test("separates what a peer could plant in from what cannot be inspected", () => {
    const { writable, unreadable } = classifyPathEntries(
      "/usr/local/bin:/usr/bin:/opt/does-not-exist/bin:/opt/pipx_bin",
      inspect,
    );
    expect(writable).toEqual(["/usr/local/bin", "/opt/pipx_bin"]);
    expect(unreadable).toEqual(["/opt/does-not-exist/bin"]);
  });

  // An empty element means the current directory, and a tool server's is the work
  // tree -- which the agent writes. That is writable in fact, not merely unknown.
  test("counts the current directory as writable, spelled either way", () => {
    const { writable } = classifyPathEntries("/usr/bin::/bin:.", inspect);
    expect(writable).toEqual(["(empty, meaning the current directory)", "."]);
  });

  test("a clean PATH yields neither list", () => {
    expect(classifyPathEntries("/usr/bin:/bin", inspect)).toEqual({ writable: [], unreadable: [] });
  });
});

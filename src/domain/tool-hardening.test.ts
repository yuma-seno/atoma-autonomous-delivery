/**
 * tool-hardening.test.ts — which PATH entries a credential-holding server drops.
 *
 * The rule is "drop what is writable", not "replace PATH with a known-good list",
 * and the difference is the point: a project whose `environment.setup_commands`
 * put a tool somewhere unusual keeps it, and only the entries that let a peer
 * plant a binary go.
 */
import { describe, expect, test } from "bun:test";
import { pathWithoutWorldWritable, worldWritableEntries } from "./tool-hardening.ts";

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

describe("worldWritableEntries", () => {
  // What the server logs. A dropped entry nobody was told about is a "command not
  // found" with nothing connecting it to its cause.
  test("names what was removed, including the current directory", () => {
    expect(worldWritableEntries("/usr/local/bin:/usr/bin:.:/opt/pipx_bin", isWorldWritable)).toEqual([
      "/usr/local/bin",
      ".",
      "/opt/pipx_bin",
    ]);
  });

  test("is empty when nothing was removed", () => {
    expect(worldWritableEntries("/usr/bin:/bin", isWorldWritable)).toEqual([]);
  });
});

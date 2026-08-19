/**
 * The two invariants of the confined shell's identity, both of which have already
 * been violated once and neither of which shows up as an error at the time.
 *
 * A collision on the uid, and a subordinate range naming ids the container cannot
 * see, both surface as one line inside one tool call, hours later, in a run nobody
 * is watching. So they are pinned here instead.
 */
import { describe, expect, test } from "bun:test";
import {
  assertIdentityIsFree,
  CONTAINER_UID,
  CONTAINER_USER_NAME,
  ID_MAP_SHIM,
  SUBID_RANGE,
} from "./prepare_shell_confinement.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How many ids exist inside the container, measured from inside it:
 *
 *   $ cat /proc/self/uid_map
 *            0       1001          1
 *            1     165536      65536
 *
 * A user namespace maps only ids its parent already has, and this container is the
 * parent of every nested one.
 */
const IDS_THE_CONTAINER_HAS = 65536;

describe("the container's subordinate id range", () => {
  test("fits inside the mapping the container itself has", () => {
    const [start, count] = SUBID_RANGE.split(":").map(Number) as [number, number];
    expect(start).toBeGreaterThan(0);
    expect(
      start + count,
      `${SUBID_RANGE} reaches id ${start + count}, which does not exist inside the ` +
        `container. newuidmap refuses that with the same EPERM as a missing privilege, ` +
        `so the message does not say which of the two went wrong.`,
    ).toBeLessThanOrEqual(IDS_THE_CONTAINER_HAS);
  });

  // The boundary that matters is the bottom, not CONTAINER_UID. Outer 0 is the host
  // runner user; leaving it out of the delegated range is what keeps it out of reach
  // of anything a nested container runs. Inner 0 does not need it -- podman's first
  // mapping line points inner 0 at CONTAINER_UID.
  test("does not delegate outer 0, which is the host runner user", () => {
    const [start] = SUBID_RANGE.split(":").map(Number) as [number, number];
    expect(start, `${SUBID_RANGE} hands out outer 0`).toBeGreaterThan(0);
  });

  // At 50000 wide, an image with a non-root USER above that could not start:
  // `crun: setgroups: Invalid argument`. distroless is 65532 and `nobody` is 65534,
  // so the width is not a detail.
  test("is wide enough for the non-root users images actually use", () => {
    const [start, count] = SUBID_RANGE.split(":").map(Number) as [number, number];
    for (const uid of [1000, 65532, 65534]) {
      const inside = uid >= start && uid < start + count;
      expect(inside, `uid ${uid} does not exist inside a nested container`).toBe(true);
    }
    expect(CONTAINER_UID).toBeGreaterThan(0);
  });
});

describe("the identity check", () => {
  const hostPasswd = "root:x:0:0::/root:/bin/bash\nrunner:x:1001:1001::/home/runner:/bin/bash\n";

  test("passes when the host uses neither the name nor the id", () => {
    expect(() => assertIdentityIsFree(hostPasswd)).not.toThrow();
  });

  // This is the one that happened: the runner image has `packer` at 1000, the
  // generated passwd is the host's plus one line, and the earlier entry wins.
  test("refuses an id the host already uses", () => {
    const withCollision = `${hostPasswd}packer:x:${CONTAINER_UID}:${CONTAINER_UID}::/home/packer:/bin/bash\n`;
    expect(() => assertIdentityIsFree(withCollision)).toThrow(/already uses uid/);
  });

  test("refuses a name the host already uses", () => {
    const name = CONTAINER_USER_NAME;
    const withCollision = `${hostPasswd}${name}:x:4242:4242::/home/${name}:/bin/bash\n`;
    expect(() => assertIdentityIsFree(withCollision)).toThrow(/already has an account named/);
  });
});

/**
 * The shim stands in for newuidmap, so what podman hands it has to come back out as
 * the map file's own format: one line of "inside outside count" per triple, all of
 * it in a single write.
 *
 * The real invocation, from #426:
 *
 *   newuidmap 44 0 1234 1 1 10000 50000
 *
 * and the two lines that run then wrote by hand, successfully. Getting this wrong
 * fails inside a container, at a depth where the error says only EPERM.
 *
 * Runs the generated script for real rather than reading it, with only the
 * destination substituted -- /proc/<pid>/uid_map cannot be faked and is one line of
 * redirection anyway.
 */
describe("the id-mapping shim", () => {
  const linux = process.platform === "linux";
  const runShim = (name: string, args: string[]): { out: string; code: number } => {
    const dir = mkdtempSync(join(tmpdir(), "shim-"));
    const target = join(dir, "map");
    const script = join(dir, name);
    writeFileSync(script, ID_MAP_SHIM.replace('> "/proc/$pid/$map"', '> "$ATOMA_TEST_MAP"'));
    const result = Bun.spawnSync({
      cmd: ["sh", script, ...args],
      env: { ...process.env, ATOMA_TEST_MAP: target },
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    try {
      out = readFileSync(target, "utf8");
    } catch {
      out = "";
    }
    return { out, code: result.exitCode ?? -1 };
  };

  test.skipIf(!linux)("turns podman's argv into the map file's own format", () => {
    const { out, code } = runShim("newuidmap", ["44", "0", "1234", "1", "1", "10000", "50000"]);
    expect(code).toBe(0);
    expect(out).toBe("0 1234 1\n1 10000 50000\n");
  });

  test.skipIf(!linux)("refuses a call with no mapping rather than writing nothing", () => {
    const { code } = runShim("newuidmap", ["44"]);
    expect(code).not.toBe(0);
  });

  // One file under both names, so which map it writes can only come from argv[0].
  test("chooses the map file from the name it was invoked as", () => {
    expect(ID_MAP_SHIM).toContain("*gidmap) map=gid_map");
    expect(ID_MAP_SHIM).toContain("map=uid_map");
  });

  // The setuid bit is what broke the two versions before this one: it clears the
  // ambient set the container's capabilities live in.
  test("is not installed setuid anywhere", () => {
    const workflow = readFileSync("dist/.github/workflows/atoma-runner.yml", "utf8");
    const install = workflow.split("\n").filter((line) => line.includes("newidmap"));
    expect(install.length).toBeGreaterThan(0);
    for (const line of install) {
      expect(line, "a setuid mode would throw away the ambient capabilities").not.toMatch(/[24]7?55|u\+s/);
    }
  });
});

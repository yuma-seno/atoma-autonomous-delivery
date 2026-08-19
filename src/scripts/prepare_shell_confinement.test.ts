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
  SUBID_RANGE,
} from "./prepare_shell_confinement.ts";

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

  test("does not run through the id the container itself uses", () => {
    const [start, count] = SUBID_RANGE.split(":").map(Number) as [number, number];
    const contains = CONTAINER_UID >= start && CONTAINER_UID < start + count;
    expect(contains, `${SUBID_RANGE} contains CONTAINER_UID ${CONTAINER_UID}`).toBe(false);
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

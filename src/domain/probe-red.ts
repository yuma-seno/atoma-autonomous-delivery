/**
 * probe-red.ts — TEMPORARY. Delete once the failing-path verification is done.
 *
 * Exists to make CI fail on purpose, so the validation path can be watched doing
 * what unit tests can only assert in isolation: write a failing check, leave the
 * engineer a comment naming the run, and dispatch it.
 */
export function addsUp(a: number, b: number): number {
  return a + b;
}

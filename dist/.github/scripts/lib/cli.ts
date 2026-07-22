/**
 * cli.ts — Tiny helper for building `--flag value` argv arrays from a typed
 * options object.
 *
 * Used on the *workflow-authoring* side (src/workflows/*.wac.ts, which may
 * import types -- and this pure helper -- from this self-contained
 * directory) so that invoking a script from a workflow step is checked
 * against that script's own exported `Args` interface: a typo'd or missing
 * required flag is a compile error, not a silently-wrong `bun run` command
 * discovered only at workflow-run time.
 *
 * Scope of the guarantee: this checks flag *names* and *shape* (required vs
 * optional, string/number/boolean) at TypeScript-authoring time. It cannot
 * check the runtime *value* GitHub Actions substitutes in (e.g.
 * `${{ github.event.pull_request.number }}`), since that's a bash-level
 * expression resolved only when the workflow actually runs -- an inherent
 * limit of generating shell commands, not something any TS layer can close.
 */
export function toArgv<T extends Record<string, string | number | boolean | undefined>>(args: T): string[] {
  const argv: string[] = [];
  for (const [flag, value] of Object.entries(args)) {
    if (value === undefined) continue;
    // Double-quote every value: these argv arrays are joined with spaces and
    // spliced directly into a bash `run:` heredoc, so any value that is
    // itself a `${VAR}`/`${{ ... }}` expansion must stay quoted the same way
    // hand-written bash would quote it (safe no-op for plain identifiers
    // like issue numbers or agent names).
    argv.push(`--${flag}`, `"${String(value)}"`);
  }
  return argv;
}

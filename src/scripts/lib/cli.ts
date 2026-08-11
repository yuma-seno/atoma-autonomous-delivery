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
    // spliced directly into a bash `run:` heredoc, so a value that is itself a
    // `${VAR}`/`${{ ... }}` expansion has to stay quoted or it word-splits.
    //
    // Quoting is NOT a safety boundary, and reading it as one is how an
    // injection gets written. Double quotes stop word splitting and globbing;
    // they do not stop `$(...)`, backticks, or `${...}`, all of which still
    // expand inside them. For a `${{ }}` expression that is doubly true: the
    // value is substituted into the script TEXT before bash parses it, so a
    // quote character in the value simply ends the string.
    //
    // What makes these call sites safe is therefore the value's provenance, not
    // this function. Values reaching a generated `run:` must be validated
    // before they get here -- see atoma-runner.wac.ts's "Validate workflow
    // inputs" step, which is the boundary for every input that workflow splices
    // into shell text.
    argv.push(`--${flag}`, `"${String(value)}"`);
  }
  return argv;
}

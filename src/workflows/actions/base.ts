/**
 * base.ts — A minimal, typed wrapper for GitHub composite actions
 * that aren't in the public `@github-actions-workflow-ts/actions` registry
 * (i.e. Atoma's own composite actions under `yuma-seno/atoma/github/actions/*`).
 *
 * Unlike `@github-actions-workflow-ts/actions`'s `BaseAction`, this does NOT
 * attempt marketplace semver-tag validation (that machinery assumes a public
 * `owner/repo@vX` action pinned to a released version; our actions are
 * internal, path-nested (`owner/repo/path/to/action@ref`), and pinned to
 * `@main`, not a semver tag). What it DOES give us, matching the same idea
 * as `BaseAction`:
 *   - A typed `with` object -- the input keys/types are checked at the call
 *     site, so a typo'd or missing required input is a compile error.
 *   - A typed `outputs` object -- each key resolves to the
 *     `${{ steps.<id>.outputs.<name> }}` expression string, so referencing a
 *     step's output elsewhere is typo-checked and refactor-safe (renaming an
 *     output name updates every usage via TS, not a raw string search).
 */
import { Step } from "@github-actions-workflow-ts/lib";
import type { GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";

export type StepBaseProps = Pick<GWT.Step, "id" | "name" | "if" | "env" | "timeout-minutes">;

/**
 * Base for any step (plain `run:` script or `uses:` action) that wants
 * typo-checked, refactor-safe references to its own `$GITHUB_OUTPUT` values
 * from other steps -- each key in `outputNames` becomes a property on
 * `.outputs` resolving to `${{ steps.<id>.outputs.<name> }}` (for use as an
 * ordinary value, e.g. in `with:`/`env:`/`run:`) and on `.rawOutputs`
 * resolving to the bare `steps.<id>.outputs.<name>` (for composing `if:`
 * conditions -- GitHub Actions explicitly warns that partially wrapping an
 * `if:` expression in `${{ }}` and concatenating literal text around it
 * produces unpredictable results, so `if:` conditions must stay either fully
 * bare or fully `${{ }}`-wrapped, never mixed).
 */
export class TypedOutputsStep<TOutputs extends string = never> extends Step {
  readonly outputs: Record<TOutputs, string>;
  readonly rawOutputs: Record<TOutputs, string>;

  constructor(stepProps: GWT.Step, outputNames: readonly TOutputs[] = []) {
    super(stepProps);
    this.outputs = {} as Record<TOutputs, string>;
    this.rawOutputs = {} as Record<TOutputs, string>;
    for (const name of outputNames) {
      const ref = this.id ? `steps.${this.id}.outputs.${name}` : "";
      this.outputs[name] = ref ? `\${{ ${ref} }}` : "";
      this.rawOutputs[name] = ref;
    }
  }
}

/**
 * Typed wrapper for GitHub composite actions that aren't in the public
 * `@github-actions-workflow-ts/actions` registry (i.e. Atoma's own composite
 * actions under `yuma-seno/atoma/github/actions/*`).
 *
 * Unlike that package's `BaseAction`, this does NOT attempt marketplace
 * semver-tag validation (that machinery assumes a public `owner/repo@vX`
 * action pinned to a released version; our actions are internal,
 * path-nested (`owner/repo/path/to/action@ref`), and pinned to `@main`, not
 * a semver tag). What it DOES give us, matching the same idea as
 * `BaseAction`:
 *   - A typed `with` object -- a typo'd or missing required input is a
 *     compile error.
 *   - A typed `outputs` object (via `TypedOutputsStep`) -- referencing a
 *     step's output elsewhere is typo-checked and refactor-safe.
 */
export abstract class CustomAction<
  TWith extends object,
  TOutputs extends string = never,
> extends TypedOutputsStep<TOutputs> {
  constructor(uses: string, props: StepBaseProps & { with: TWith }, outputNames: readonly TOutputs[] = []) {
    super({ ...props, uses, with: props.with as unknown as GWT.Env }, outputNames);
  }
}


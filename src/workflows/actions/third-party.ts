/**
 * third-party-actions.ts — Typed wrappers for third-party actions we use
 * that aren't (yet) in the public `@github-actions-workflow-ts/actions`
 * registry.
 */
import { CustomAction, type StepBaseProps } from "./base.ts";

export interface SetupBunInputs {
  "bun-version"?: string;
}

export class SetupBunAction extends CustomAction<SetupBunInputs> {
  constructor(props: StepBaseProps & { with?: SetupBunInputs } = {}) {
    super("oven-sh/setup-bun@v2", { ...props, with: props.with ?? { "bun-version": "latest" } });
  }
}

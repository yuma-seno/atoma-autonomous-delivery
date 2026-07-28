/**
 * cache.ts — Typed wrapper for `actions/cache@v4`.
 *
 * Caches npm/pip download directories to speed up repeated package
 * installations across workflow runs. The cache key is derived from
 * the package manifest hash; partial-match restore keys allow
 * fallback to an older cache when the manifest changes.
 */
import { CustomAction, type StepBaseProps } from "./base.ts";

export interface CacheActionInputs {
  path: string;
  key: string;
  "restore-keys"?: string;
}

export class CacheAction extends CustomAction<CacheActionInputs> {
  constructor(props: StepBaseProps & { with: CacheActionInputs }) {
    super("actions/cache@v4", props);
  }
}

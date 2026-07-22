/**
 * permissions.ts — Shared `GITHUB_TOKEN` permission set used across nearly
 * every Atoma workflow file. `atoma-entry`, `atoma-auto-trigger`,
 * `atoma-manual-comment`, `atoma-pr-review`, `atoma-runner`, and
 * `atoma-sub-issue-closed` all need the identical full set (they may create
 * branches, manage labels, post comments, and dispatch follow-up runs) --
 * before this existed, that was 6 independently hand-copied object literals
 * with no compiler link between them, free to silently drift apart (e.g. one
 * file's permissions getting tightened/loosened without the others noticing).
 * `atoma-pr-merged` is the one legitimate exception (`pull-requests: "read"`,
 * it only ever reads PR metadata) -- spread `ATOMA_WORKFLOW_PERMISSIONS` and
 * override just that key there, rather than duplicating the whole object.
 */
import type { GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";

export const ATOMA_WORKFLOW_PERMISSIONS: GWT.PermissionsEvent = {
  actions: "write",
  issues: "write",
  "pull-requests": "write",
  contents: "write",
};

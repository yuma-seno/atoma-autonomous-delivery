import { Workflow, NormalJob } from "@github-actions-workflow-ts/lib";
import type { GeneratedWorkflowTypes as GWT } from "@github-actions-workflow-ts/lib";
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import {
  DispatchNextAction,
  PostResultAction,
  PrepareAction,
  RunAgentAction,
  SetupRuntimeAction,
} from "./actions/atoma.ts";
import { TypedOutputsStep } from "./actions/base.ts";
import { SetupBunAction } from "./actions/third-party.ts";
import { toArgv } from "../scripts/lib/cli.ts";
import type { ResolveNotifyArgs } from "../scripts/resolve_notify.ts";
import { buildArgv as configValueArgv } from "../scripts/get_config_value.ts";
import type { ManageInProgressLabelArgs } from "../scripts/manage_in_progress_label.ts";
import type { NotifyMaxIterationsArgs } from "../scripts/notify_max_iterations.ts";

const AGENT_INPUT_DESC = "Agent name to invoke";
const NUMBER_INPUT_DESC = "Issue or PR number";
const NOTIFY_INPUT_DESC = "GitHub login to mention on completion";
const ATOMA_VERSION_DESC =
  "Atoma CLI version tag to install, or `source` to build from the checked-out action repository";

const checkoutStep = new ActionsCheckoutV4({
  name: "Checkout repository",
  with: {
    ref: "${{ inputs.type == 'pr' && format('refs/pull/{0}/head', inputs.number) || '' }}",
  },
});

const createFeatureBranchStep = new TypedOutputsStep({
  name: "Create feature branch for issue",
  if: "inputs.type == 'issue'",
  shell: "bash",
  run: `BRANCH="atoma/issue-\${{ inputs.number }}"
git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
echo "BRANCH=$BRANCH" >> $GITHUB_ENV
`,
});

const setBranchEnvStep = new TypedOutputsStep({
  name: "Set branch env for PR type",
  if: "inputs.type != 'issue'",
  shell: "bash",
  run: `echo "BRANCH=$(git rev-parse --abbrev-ref HEAD)" >> $GITHUB_ENV
`,
});

const setupRuntimeStep = new SetupRuntimeAction({ name: "Setup runtime" });

// Required for every subsequent step / the "Run agent" step itself (tools.yaml
// spawns the atoma MCP servers via `bun run ...`) -- GitHub-hosted runners do
// not ship Bun preinstalled.
const setupBunStep = new SetupBunAction({ name: "Setup Bun" });

// The MCP servers under .github/atoma/tools/scripts/mcp/ depend on
// @modelcontextprotocol/sdk. Installing it scoped to their own
// scripts/package.json (rather than relying on a repo-root package.json)
// keeps this whole workflow self-sufficient: copying just `.github/` into a
// project is enough for it to work, with no root-level Node project required.
const installMcpDepsStep = new TypedOutputsStep({
  name: "Install MCP server dependencies",
  shell: "bash",
  "working-directory": ".github/atoma/tools/scripts",
  run: "bun install\n",
});

const environmentSetupStep = new TypedOutputsStep({
  name: "Run configured environment setup",
  shell: "bash",
  run: "bun run .github/atoma/tools/scripts/run_environment_setup.ts\n",
});

const gitIdentityStep = new TypedOutputsStep({
  name: "Configure git identity",
  shell: "bash",
  run: `git config user.name "atoma-\${{ inputs.agent }}"
git config user.email "atoma-\${{ inputs.agent }}@users.noreply.github.com"
`,
});

const notifyStep = new TypedOutputsStep(
  {
    // Defense in depth: inputs.notify *should* already carry the human to
    // ping (see resolve_notify.ts / atoma:notify= tag propagation), but if
    // it ever arrives empty (a missed dispatch path, a new caller that
    // forgot to wire it, etc.) we do a live fallback lookup here so a run
    // that ends with neither a next-agent directive nor a notify never goes
    // completely silent. Cheap no-op when notify is already set.
    name: "Resolve effective notify login",
    id: "notify",
    shell: "bash",
    env: {
      GH_TOKEN: "${{ github.token }}",
      NOTIFY: "${{ inputs.notify }}",
      NUMBER: "${{ inputs.number }}",
    },
    run: `EFFECTIVE="$NOTIFY"
if [ -z "$EFFECTIVE" ]; then
  EFFECTIVE=$(bun run .github/atoma/tools/scripts/resolve_notify.ts ${toArgv({ repo: "\${GITHUB_REPOSITORY}", number: "\${NUMBER}" } satisfies ResolveNotifyArgs).join(" ")})
  [ -n "$EFFECTIVE" ] && echo "Resolved notify fallback: \${EFFECTIVE}"
fi
echo "notify=\${EFFECTIVE}" >> "$GITHUB_OUTPUT"
`,
  },
  ["notify"] as const,
);

const prepareStep = new PrepareAction({
  name: "Prepare shared context",
  id: "prep",
  with: {
    type: "${{ inputs.type }}",
    number: "${{ inputs.number }}",
    agent_name: "${{ inputs.agent }}",
    orchestration_file: ".github/atoma/config.json",
  },
});

const cfgStep = new TypedOutputsStep(
  {
    name: "Read max_iterations from config",
    id: "cfg",
    shell: "bash",
    env: { AGENT_NAME: "${{ inputs.agent }}" },
    run: `MAX=$(bun run .github/atoma/tools/scripts/get_config_value.ts ${configValueArgv("agents.${AGENT_NAME}.max_iterations", "30").join(" ")})
echo "max_iterations=\${MAX}" >> "$GITHUB_OUTPUT"
echo "Agent \${AGENT_NAME} max_iterations: \${MAX}"
`,
  },
  ["max_iterations"] as const,
);

const addInProgressLabelStep = new TypedOutputsStep({
  // Added BEFORE the agent actually runs (not after) so it's visible to a
  // human for the entire duration of the run, not just flickered on/off
  // afterwards. Applies to both issues and PRs -- `gh issue edit` works on
  // PR numbers too since GitHub treats every PR as an issue under the hood.
  // Gated on the same condition as "Run agent" so the label isn't added for
  // no-op runs that will be skipped entirely (new_event_count == '0').
  name: "Add atoma/in-progress label",
  if: `${prepareStep.rawOutputs.new_event_count} != '0'`,
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: "${{ inputs.number }}",
  },
  run: `bun run .github/atoma/tools/scripts/manage_in_progress_label.ts ${toArgv({ action: "add", number: "\${NUMBER}" } satisfies ManageInProgressLabelArgs).join(" ")}
`,
});

const runAgentStep = new RunAgentAction({
  name: "Run agent",
  id: "atoma",
  if: `${prepareStep.rawOutputs.new_event_count} != '0'`,
  with: {
    agent_name: "${{ inputs.agent }}",
    agent_def_dir: ".github/atoma/agent-definitions",
    tools_file: ".github/atoma/tools/tools.yaml",
    issue_number: prepareStep.outputs.resolved_number,
    orchestration_file: ".github/atoma/config.json",
    atoma_version: "${{ inputs.atoma_version }}",
    max_iterations: cfgStep.outputs.max_iterations,
    notify_login: notifyStep.outputs.notify,
    openai_api_key: "${{ secrets.OPENAI_API_KEY }}",
    openai_base_url: "${{ vars.OPENAI_BASE_URL }}",
    anthropic_api_key: "${{ secrets.ANTHROPIC_API_KEY }}",
    atoma_provider: "${{ vars.ATOMA_PROVIDER }}",
  },
});

const removeInProgressLabelStep = new TypedOutputsStep({
  // Remove atoma/in-progress when the agent run finishes (success or
  // failure). Sub-issues keep atoma/sub-issue label for tracking (never
  // removed here). Applies to both issues and PRs, mirroring the Add step
  // above.
  name: "Remove atoma/in-progress label on completion",
  if: "always()",
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: "${{ inputs.number }}",
  },
  run: `bun run .github/atoma/tools/scripts/manage_in_progress_label.ts ${toArgv({ action: "remove", number: "\${NUMBER}" } satisfies ManageInProgressLabelArgs).join(" ")}
`,
});

const postResultStep = new PostResultAction({
  // post-result's own inner guard (atoma_outcome == 'success' &&
  // new_event_count != '0') is sufficient: it always posts the agent's
  // final response as a comment when the run actually did something. Do NOT
  // gate the comment itself on `directive` being empty -- that shape is
  // indistinguishable from a normal "nothing more to do" completion AND from
  // an important final summary (e.g. orchestrator aggregation), so gating
  // on it would silently drop real summaries/notifications instead of just
  // reducing noise. The "please review" notice inside post-result is
  // separately suppressed via `chain_continues` (set when a tool call, e.g.
  // launch_sub_agent or create_pr, already triggered an automatic follow-up
  // run) -- that is a purpose-built signal, not a reuse of the ambiguous
  // `directive` emptiness.
  name: "Post result",
  if: "always()",
  with: {
    agent_name: "${{ inputs.agent }}",
    number: "${{ inputs.number }}",
    type: "${{ inputs.type }}",
    notify: notifyStep.outputs.notify,
    job_status: "${{ job.status }}",
    atoma_outcome: "${{ steps.atoma.outcome }}",
    new_event_count: prepareStep.outputs.new_event_count,
    context_snapshot_hash: prepareStep.outputs.context_snapshot_hash,
    context_event_count: prepareStep.outputs.context_event_count,
    resolved_number: prepareStep.outputs.resolved_number,
    directive: runAgentStep.outputs.directive,
    max_iterations_reached: runAgentStep.outputs.max_iterations_reached,
    chain_continues: runAgentStep.outputs.chain_continues,
  },
});

const dirtyStep = new TypedOutputsStep(
  {
    name: "Check for uncommitted changes",
    id: "dirty",
    if: "steps.atoma.outcome == 'success'",
    shell: "bash",
    run: `if [ -n "$(git status --porcelain)" ]; then
  echo "has_changes=true" >> "$GITHUB_OUTPUT"
fi
`,
  },
  ["has_changes"] as const,
);

const injectUncommittedStep = new TypedOutputsStep({
  name: "Inject uncommitted changes into session",
  if: `${dirtyStep.rawOutputs.has_changes} == 'true'`,
  shell: "bash",
  run: "bun run .github/atoma/tools/scripts/inject_uncommitted_notice.ts\n",
});

const notifyMaxIterationsStep = new TypedOutputsStep({
  name: "Notify on max iterations",
  if: `${runAgentStep.rawOutputs.max_iterations_reached} == 'true'`,
  shell: "bash",
  env: {
    GH_TOKEN: "${{ github.token }}",
    NUMBER: "${{ inputs.number }}",
    NOTIFY: notifyStep.outputs.notify,
    AGENT: "${{ inputs.agent }}",
  },
  run: `bun run .github/atoma/tools/scripts/notify_max_iterations.ts ${toArgv({ number: "\${NUMBER}", agent: "\${AGENT}", notify: "\${NOTIFY}" } satisfies NotifyMaxIterationsArgs).join(" ")}
`,
});

const dispatchNextStep = new DispatchNextAction({
  name: "Dispatch next agent",
  if: "steps.atoma.outcome == 'success'",
  with: {
    agent_name: "${{ inputs.agent }}",
    number: "${{ inputs.number }}",
    type: "${{ inputs.type }}",
    notify: notifyStep.outputs.notify,
    directive: runAgentStep.outputs.directive,
    max_iterations_reached: runAgentStep.outputs.max_iterations_reached,
    new_event_count: prepareStep.outputs.new_event_count,
    atoma_outcome: "${{ steps.atoma.outcome }}",
    orchestration_file: ".github/atoma/config.json",
  },
});

const runJob = new NormalJob("run", {
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 60,
  concurrency: {
    group: "atoma-${{ inputs.type }}-${{ inputs.number }}",
    "cancel-in-progress": false,
  },
  permissions: {
    actions: "write",
    issues: "write",
    "pull-requests": "write",
    contents: "write",
  },
}).addSteps([
  checkoutStep,
  createFeatureBranchStep,
  setBranchEnvStep,
  setupRuntimeStep,
  setupBunStep,
  installMcpDepsStep,
  environmentSetupStep,
  gitIdentityStep,
  notifyStep,
  prepareStep,
  cfgStep,
  addInProgressLabelStep,
  runAgentStep,
  removeInProgressLabelStep,
  postResultStep,
  dirtyStep,
  injectUncommittedStep,
  notifyMaxIterationsStep,
  dispatchNextStep,
]);

export const atomaRunner = new Workflow("atoma-runner", {
  name: "Atoma Runner",
  // Cast: the generated `WorkflowDispatchInput.default` type is an upstream
  // json-schema-to-typescript quirk (typed as a generic object, not the
  // string/boolean/number the real schema allows) -- see
  // https://github.com/emmanuelnk/github-actions-workflow-ts. Structurally
  // this object is valid workflow_call/workflow_dispatch YAML.
  on: {
    workflow_call: {
      inputs: {
        agent: { description: AGENT_INPUT_DESC, required: true, type: "string" },
        number: { description: NUMBER_INPUT_DESC, required: true, type: "string" },
        type: { description: "Context type", required: true, type: "string" },
        notify: { description: NOTIFY_INPUT_DESC, required: false, type: "string", default: "" },
        atoma_version: { description: ATOMA_VERSION_DESC, required: false, type: "string", default: "source" },
      },
    },
    workflow_dispatch: {
      inputs: {
        agent: { description: AGENT_INPUT_DESC, required: true, type: "string" },
        number: { description: NUMBER_INPUT_DESC, required: true, type: "string" },
        type: { description: "Context type", required: true, type: "choice", options: ["issue", "pr"] },
        notify: { description: NOTIFY_INPUT_DESC, required: false, type: "string", default: "" },
        atoma_version: { description: ATOMA_VERSION_DESC, required: false, type: "string", default: "source" },
      },
    },
  } as unknown as GWT.Workflow["on"],
}).addJob(runJob);

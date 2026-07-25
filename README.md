# atoma-autonomous-delivery

AI-powered autonomous delivery from issue intake to PR — powered by [Atoma](https://github.com/yuma-seno/atoma).

Three agents (orchestrator → engineer → reviewer) collaborate to decompose requirements, implement code, and review changes. Humans act as supervisors.

## Prerequisites

- An **LLM API key** from one of the supported providers:
  - **OpenRouter** (recommended, default)
  - **OpenAI**
  - **Anthropic**
  - **GitHub Copilot**
- A **GitHub repository** where you have admin access (to set secrets and workflows)
- **GitHub Actions の Pull Request 作成を許可** — リポジトリの **Settings → Actions → General** の一番下にある
  **"Allow GitHub Actions to create and approve pull requests"** にチェックを入れてください。
  これを有効にしないと、`GITHUB_TOKEN` による PR 作成が GraphQL レベルでブロックされます。

## Quick Start

### 1. Copy the template

```bash
# Clone your target repository
git clone https://github.com/YOUR_ORG/YOUR_REPO.git
cd YOUR_REPO

# Copy this template's deliverable (dist/.github/) into your repo as .github/
# -- NOT this template's own top-level .github/, which is only its own dev CI.
git clone --depth 1 https://github.com/yuma-seno/atoma-autonomous-delivery.git /tmp/atoma-template
cp -r /tmp/atoma-template/dist/.github ./.github
rm -rf /tmp/atoma-template
```

Or simply copy the `dist/.github/` directory from this repository into your own repo's root as `.github/`.

### 2. Set required secrets and variables

Go to **Settings → Secrets and variables → Actions** in your repository and configure them.

#### Required secrets

| Secret | Value |
|---|---|
| `OPENAI_API_KEY` | Your OpenRouter or OpenAI API key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (only if using Claude models) |

> **Note:** Set `OPENAI_API_KEY` even when using OpenRouter — Atoma uses OpenAI-compatible endpoints. Use your OpenRouter API key and set `OPENAI_BASE_URL` to `https://openrouter.ai/api/v1` (see Variables below).

#### Provider-specific setup

**A) OpenRouter (recommended) — simplest setup:**

| Setting | Type | Value |
|---|---|---|
| `OPENAI_API_KEY` | Secret | `sk-or-v1-...` (your OpenRouter API key) |
| `OPENAI_BASE_URL` | Variable | `https://openrouter.ai/api/v1` |
| `ATOMA_PROVIDER` | — | *(leave empty)* |

**B) OpenAI:**

| Setting | Type | Value |
|---|---|---|
| `OPENAI_API_KEY` | Secret | `sk-...` (your OpenAI API key) |
| `OPENAI_BASE_URL` | — | *(leave empty — defaults to `https://openrouter.ai/api/v1`)* |
| `ATOMA_PROVIDER` | — | *(leave empty)* |

**C) Anthropic (Claude):**

| Setting | Type | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | `sk-ant-...` (your Anthropic API key) |
| `ATOMA_PROVIDER` | Variable | `anthropic` |

**D) GitHub Copilot (requires PAT with `copilot` scope):**

| Setting | Type | Value |
|---|---|---|
| `GITHUB_PAT_TOKEN` | Secret | `github_pat_...` (PAT with `copilot` scope) |
| `ATOMA_PROVIDER` | Variable | `github-copilot` |

> **Note:** `GITHUB_PAT_TOKEN` is only required when using the GitHub Copilot provider. It is exposed to Atoma as `ATOMA_COPILOT_TOKEN`. For OpenRouter/OpenAI/Anthropic, the auto-generated `GITHUB_TOKEN` is sufficient.

### 3. Create an issue to kick off

Create a new issue with the body:

```
/orchestrator

...your detailed requirements...
```

The orchestrator will be invoked automatically when the issue is opened. The slash command must appear on the first line of the issue body.

> **Note:** All agent dispatch is now driven by `config.json`. Labels and shell scripts for triggering agents have been removed.

### 4. Sit back

The orchestrator will:
1. Analyze the issue
2. Decompose work into sub-issues via GitHub MCP
3. Dispatch agents on each sub-issue via `atoma__launch_sub_agent` MCP tool
4. Session ends — the orchestrator waits for all sub-issues to complete
5. When all sub-issues are closed, the orchestrator is automatically re-invoked with results
6. The orchestrator aggregates results and reports completion

---

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `atoma-entry.yml` | Issue opened | Start agent from issue body `/agent-name` slash command |
| `atoma-manual-comment.yml` | Issue/PR comment | Manually invoke any agent via `/agent-name`, or dispatch via `<!-- atoma:dispatch=AGENT -->` |
| `atoma-auto-trigger.yml` | PR/review events | Read `config.json` auto_triggers, dispatch matching agents |
| `atoma-sub-issue-closed.yml` | Issue closed | Detect sub-issue completion; inject results into session and re-invoke orchestrator |
| `atoma-runner.yml` | (reusable) | Core executor: prepare → run → post-result |

## Agent Definitions

See `.github/atoma/agent-definitions/`:

- **orchestrator** — Issue intake, decomposition, delegation, aggregation
- **engineer** — Implementation and fixes
- **reviewer** — Quality gate with automatic fix loop

## Configuration

`.github/atoma/config.json` centralizes all configuration:

- **agents** — per-agent `max_iterations`
- **auto_triggers** — GitHub events mapped to agents (no per-agent workflow files needed)
- **dispatch.workflow** — which workflow to use for agent execution

### Adding an agent

1. Create `.github/atoma/agent-definitions/my-agent.md` with frontmatter
2. Add it to `config.json` under `agents` with its `max_iterations` and `shared_context`
3. Add an `auto_trigger` entry if you want it invoked by GitHub events
4. Add it to `known_about` in other agent definitions if they should be able to call it

No workflow files need to be created — `atoma-auto-trigger.yml` and `atoma-entry.yml` are fully generic.

### Multi-Issue Orchestration

The orchestrator follows a clean, natural lifecycle:

```
1. New issue (/orchestrator) → orchestrator runs
2. orchestrator creates sub-issues via GitHub MCP
3. orchestrator calls atoma__launch_sub_agent(tasks=[{issue: N, agent: "engineer"}, ...])
4. Session ends; dispatch comments are posted on sub-issues
5. `atoma__launch_sub_agent` directly dispatches the reusable runner workflow
6. When every sub-issue is closed → session is updated with results → orchestrator re-invoked
7. orchestrator aggregates results → reports completion
```

**From the orchestrator's perspective, this is a single blocking tool call:** it calls `atoma__launch_sub_agent` and gets back the aggregated results of all sub-issues. The system handles dispatch, waiting, and re-invocation transparently.

## Prompt Template

`.github/atoma/prompt-template.md` is the custom system prompt template passed to Atoma by the runner workflow. It extends the built-in template with autonomous-delivery-specific guidance (GitHub workflow, PR conventions, etc.).

## Skills

`.github/atoma/skills/` contains reusable operating procedures. Every agent sees
only each skill's name and description through `{{AVAILABLE_SKILLS}}`; it loads
full instructions on demand with the always-available
`atoma_builtin__load_skill` tool. Skill loads remain in the ordinary persisted
session history. Skills are host-level capabilities and are not assigned in
agent definitions or declared in `tools.yaml`.

## Tools

See `.github/atoma/tools/tools.yaml`:

- **filesystem** — Read/write access (engineer only). `directory_tree` and `search_files` are denied.
- **filesystem_readonly** — Read-only access (orchestrator, reviewer)
- **shell** — Command execution (guarded by `hooks/shell_guard.ts`)
- **github** — GitHub API access via MCP

## Session Persistence

Agent memory is stored in an orphan Git branch called `atoma-data` within your repository. This branch is automatically created on first use and persists across workflow runs without relying on GitHub Cache (which expires after 7 days).

A PR created for an Issue is a serial continuation of that Issue. Runs started from either the parent Issue or any linked PR reconcile the parent Issue and all linked PR events into the same GitHub context. For the same agent, they also restore and save the same canonical `sessions/issue-{number}-{agent}.json` session, preserving assistant and tool history across both surfaces. Unlinked PRs retain their own PR session.

## Resource Estimates

| Model | ~Prompt tokens | ~Completion tokens | ~Cost |
|---|---|---|---|
| DeepSeek V4 Flash (default) | 15,000–50,000 | 1,000–5,000 | $0.005–$0.010 |

Costs scale with issue complexity. Token usage and cost are displayed in each result comment.

---

## Development (this template's own tooling)

This repository's own `.github/workflows/ci.yml` is **hand-written YAML** — intentionally NOT generated by `github-actions-workflow-ts`, so this project's own build/CD never gets mixed up with the Atoma template-generation mechanism below. It's used only for this project's own CI. On every push to `main`, after typecheck/test pass, it also **dogfoods this template on itself**: it regenerates `dist/`, wipes `.github/` down to just `ci.yml`, repopulates it from the fresh `dist/.github/`, and commits/pushes the result if anything changed — so this repo's own issues/PRs are driven by the very Atoma workflows it produces, while `dist/.github/` stays the clean, generated template source other repos copy from.

> **Required for the dogfooding sync step:** add a `WORKFLOW_PAT` repository secret — a PAT with the `repo` + `workflow` scopes. Empirically confirmed: the default `GITHUB_TOKEN` cannot push changes to files under `.github/workflows/` ("refusing to allow a GitHub App to create or update workflow ... without `workflows` permission") — a hard GitHub restriction with no `permissions:` YAML equivalent. This repo also needs the same secrets/variables and "Allow GitHub Actions to create and approve pull requests" setting described in Quick Start above, since its own `.github/workflows/` will start running for real.

The actual deliverable lives entirely under `dist/.github/` and is fully generated from `src/`; nothing under `dist/` is ever hand-edited directly.

```
src/
├── workflows/*.wac.ts        # workflow-as-code source (github-actions-workflow-ts)
│   └── actions/               # typed Action/Step wrappers (base.ts's CustomAction for third-party actions like oven-sh/setup-bun, plus workflow-authoring helpers)
├── lib/                       # shared INFRASTRUCTURE kernel used by EVERY script/MCP server below (gh.ts, config.ts, types.ts, tags.ts, notify.ts, sibling-check.ts, aggregation.ts, ops-log.ts, inject-sub-results.ts, session.ts, mcp-tool.ts)
├── domain/                    # pure, dependency-free DECISION logic shared the same way (serialization-guard.ts, handoff.ts) -- no gh/git/filesystem calls, no I/O; see below
├── scripts/*.ts               # source for scripts invoked DIRECTLY from a *.wac.ts step (+ workflow-authoring-only helpers under lib/: cli.ts, script-ref.ts, atoma-data.ts)
└── atoma/                     # source for ATOMA'S OWN tool/hook implementations + config/agent content
    ├── config.json, prompt-template.md, agent-definitions/*.md, skills/**/*.md, tools/tools.yaml
    └── tools/scripts/         # MCP servers, before_tool hook, and the scripts they call
        ├── mcp/                # MCP stdio servers (tools.yaml's tool_servers)
        ├── hooks/              # before_tool hook
        └── lib/                      # in-process implementations imported by MCP servers (not standalone entry points)

dist/.github/                 # THE DELIVERABLE -- copy this into your own repo as .github/
├── workflows/*.yml            # generated from src/workflows/*.wac.ts
├── scripts/                    # bundled from src/scripts/** (never hand-edit here)
└── atoma/                      # bundled from src/atoma/** (never hand-edit here)
```

`src/domain/` holds genuine multi-signal business DECISIONS that used to live inline inside larger imperative functions (mixed with `gh`/git calls, or even as a raw GitHub Actions `if:` boolean expression) -- e.g. `serialization-guard.ts`'s `shouldReleaseGuard()` decides when the `atoma/in-progress` label should be released, `handoff.ts`'s `decidePostMergeHandoff()` decides what to do with a merged PR's linked parent issue. Each is a pure function, fully unit-tested with plain objects, with zero I/O -- the caller (a script or MCP tool handler) assembles the input signals, calls the domain function, then executes whatever it decided via `lib/`. Not everything pure gets promoted here: a pure function stays local to its own script file unless it expresses a genuine multi-branch decision AND has (or would gain) more than one real caller -- otherwise moving it would just be ceremony.

`src/scripts/**` and `src/atoma/tools/scripts/**` freely import from the shared `src/lib/` kernel and local `lib/` modules -- no hand-duplicated files, no subprocess-spawning one script from another. `build-dist.ts` reconciles this with the "each deployed script must be a single self-contained file, no `node_modules`, no cross-file imports" requirement by **bundling** every entry-point script individually via `Bun.build()`: all of its imports, including npm dependencies like `@modelcontextprotocol/sdk`/`shell-quote`, get inlined into one file. Verified: a bundled `mcp/github.ts` runs standalone with zero `node_modules` nearby -- so the deployed `.github/atoma/tools/scripts/**` needs no `package.json`/`bun install` step at all. Bundled output keeps a `.ts` extension (Bun runs plain JS through a `.ts`-named file just fine) so every `bun run .github/.../foo.ts` reference elsewhere needs no change.

Every MCP tool (`mcp/github.ts`, `mcp/atoma.ts`) is defined once via `lib/mcp-tool.ts`'s `defineMcpTool({name, description, schema, handler})`: a single Zod schema (imported from `"zod/v3"` -- required for `zod-to-json-schema` compatibility, see that file's doc comment) is both compiled to the `inputSchema` JSON Schema advertised to the LLM AND used to validate + parse incoming arguments into a properly-typed object before the handler runs. There used to be two independent, hand-written descriptions of every tool's arguments (a JSON Schema literal, plus a handler full of unchecked `a.title as string` casts on a bare `Record<string, unknown>`) that could silently drift apart; now there's exactly one. A malformed call from the LLM is rejected up front with a readable `field: reason` message instead of failing deep inside a `gh` call. Handlers that need the response to carry `_meta` fields (e.g. `session_ends: true`, replacing what used to be a module-level `pendingSessionEnd` mutable flag in `mcp/github.ts`) just return `{text, meta}` instead of a plain string.

**Two invariants matter for anything that ends up running in-process inside an MCP server** (`mcp/atoma.ts`/`mcp/github.ts`, and any function they import and call directly):
- Never `console.log()` — only `console.error()`. The MCP server's `process.stdout` IS the JSON-RPC stdio transport stream; a stray `console.log()` corrupts it and breaks the real tool call with an opaque "Failed to call tool" error.
- Keep reusable in-process modules under a `lib/` directory so `build-dist.ts` does not deploy them as standalone entry points.

```bash
bun install          # install this repo's own dev dependencies
bun run synth        # regenerate dist/.github/workflows/*.yml + bundle src/scripts/** and src/atoma/** into dist/.github/ (gwf build + build-dist.ts)
bun run synth:check  # verify dist/ matches its src/ source (used by .github/workflows/ci.yml)
bun run typecheck    # tsc --noEmit across all of src/ (including src/atoma/tools/scripts/**)
bun run test         # bun:test — script, lib, & MCP server behavior tests
bun run lint         # typecheck + synth:check
```

## License

This template is part of the [Atoma](https://github.com/yuma-seno/atoma) project. See [LICENSE](https://github.com/yuma-seno/atoma/blob/main/LICENSE).
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
| `atoma-manual-comment.yml` | Issue/PR comment | Manually invoke any agent via `/agent-name` in a comment |
| `atoma-auto-trigger.yml` | PR/review events | Read `config.json` auto_triggers, dispatch matching agents |
| `atoma-dispatch.yml` | Comment with `<!-- atoma:dispatch=AGENT -->` | Dispatch agent on the issue the comment belongs to |
| `atoma-sub-issue-closed.yml` | Issue closed | Detect sub-issue completion; inject results into session and re-invoke orchestrator |
| `atoma-runner.yml` | (reusable) | Core executor: setup → prepare → run → post-result |

## Agent Definitions

See `.github/atoma/agent-definitions/`:

- **orchestrator** — Issue intake, decomposition, delegation, aggregation
- **engineer** — Implementation and fixes
- **reviewer** — Quality gate with automatic fix loop

## Configuration

`.github/atoma/config.json` centralizes all configuration:

- **agents** — per-agent settings: `max_iterations`, `shared_context` event filters
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
5. atoma-dispatch.yml detects comments and dispatches agents
6. When every sub-issue is closed → session is updated with results → orchestrator re-invoked
7. orchestrator aggregates results → reports completion
```

**From the orchestrator's perspective, this is a single blocking tool call:** it calls `atoma__launch_sub_agent` and gets back the aggregated results of all sub-issues. The system handles dispatch, waiting, and re-invocation transparently.

## Prompt Template

`.github/atoma/prompt-template.md` is a custom system prompt template. Pass it to Atoma via the `--template` CLI flag. It extends the built-in template with autonomous-delivery-specific guidance (GitHub workflow, PR conventions, etc.).

## Tools

See `.github/atoma/tools/tools.yaml`:

- **filesystem** — Read/write access (engineer only). `directory_tree` and `search_files` are denied.
- **filesystem_readonly** — Read-only access (orchestrator, reviewer)
- **shell** — Command execution (guarded by `hooks/shell_guard.ts`)
- **github** — GitHub API access via MCP

## Session Persistence

Agent memory is stored in an orphan Git branch called `atoma-data` within your repository. This branch is automatically created on first use and persists across workflow runs without relying on GitHub Cache (which expires after 7 days).

## Resource Estimates

| Model | ~Prompt tokens | ~Completion tokens | ~Cost |
|---|---|---|---|
| DeepSeek V4 Flash (default) | 15,000–50,000 | 1,000–5,000 | $0.005–$0.010 |

Costs scale with issue complexity. Token usage and cost are displayed in each result comment.

---

## Calculator

This repository includes a simple command-line calculator (`calc.py`) that evaluates arithmetic expressions using Python's standard library only.

### Features

- Supports operators: `+`, `-`, `*`, `/`
- Supports parentheses for grouping expressions
- Pipe mode — pass an expression via stdin
- Interactive mode — run with no arguments for a REPL
- Error handling for division by zero

### Usage

**Pipe mode:**

```bash
echo "1 + 2" | python calc.py
# Output: 3

echo "(1 + 2) * 3" | python calc.py
# Output: 9
```

**Interactive mode:**

```bash
python calc.py
> 1 + 2
3
> 1 / 0
Error: Division by zero
```

---

## Markdown Note Manager

シンプルな Markdown ベースのノート管理CLIツール。

### セットアップ
特別な依存関係はありません。Python 3.8+ が必要です。

### 使い方

1. **ノート作成**
   ```bash
   echo "本文" | python note.py add "タイトル"
   # または $EDITOR が設定されている場合
   python note.py add "タイトル"
   ```

2. **ノート一覧表示**
   ```bash
   python note.py list
   ```

3. **ノート検索**
   ```bash
   python note.py search "キーワード"
   ```

4. **ノート表示**
   ```bash
   python note.py show 1
   ```

### 保存形式
ノートは `notes/` ディレクトリに `0001.md` のような連番ファイルで保存されます。
ファイルの先頭行がタイトル、3行目以降が本文です。

## Development (this template's own tooling)

This repository's own `.github/workflows/ci.yml` is **hand-written YAML** — intentionally NOT generated by `github-actions-workflow-ts`, so this project's own build/CD never gets mixed up with the Atoma template-generation mechanism below. It's used only for this project's own CI. On every push to `main`, after typecheck/test pass, it also **dogfoods this template on itself**: it regenerates `dist/`, wipes `.github/` down to just `ci.yml`, repopulates it from the fresh `dist/.github/`, and commits/pushes the result if anything changed — so this repo's own issues/PRs are driven by the very Atoma workflows it produces, while `dist/.github/` stays the clean, generated template source other repos copy from.

> **Required for the dogfooding sync step:** add a `WORKFLOW_PAT` repository secret — a PAT with the `repo` + `workflow` scopes. Empirically confirmed: the default `GITHUB_TOKEN` cannot push changes to files under `.github/workflows/` ("refusing to allow a GitHub App to create or update workflow ... without `workflows` permission") — a hard GitHub restriction with no `permissions:` YAML equivalent. This repo also needs the same secrets/variables and "Allow GitHub Actions to create and approve pull requests" setting described in Quick Start above, since its own `.github/workflows/` will start running for real.

The actual deliverable lives entirely under `dist/.github/` and is fully generated/copied from `src/`; it is never hand-edited directly, with one deliberate exception (see below).

```
src/
├── workflows/*.wac.ts        # workflow-as-code source (github-actions-workflow-ts)
│   └── actions/               # typed Action/Step wrappers (Atoma's own composite actions + 3rd-party)
└── scripts/*.ts               # source for the one-shot workflow-step scripts (+ shared lib/)

dist/.github/                 # THE DELIVERABLE -- copy this into your own repo as .github/
├── workflows/*.yml            # generated from src/workflows/*.wac.ts
└── atoma/
    ├── config.json, prompt-template.md, agent-definitions/*.md, tools/tools.yaml   # hand-authored directly here (pure config/content, nothing to "build")
    └── tools/scripts/
        ├── lib/, *.ts          # copied verbatim from src/scripts/ (never hand-edit here)
        ├── mcp/                # hand-authored directly here (as-is exception): MCP stdio servers
        └── hooks/              # hand-authored directly here (as-is exception): before_tool hook
```

`dist/.github/atoma/tools/scripts/mcp/` and `hooks/` are the one deliberate exception to "never hand-edit `dist/`": they're already in final, runnable form (Bun runs `.ts` directly, no compile step), tightly coupled to the equally-hand-authored `tools.yaml` beside them, so extracting them into `src/` and copying them back would add indirection with no benefit.

Because the deliverable must work when copied alone (no root-level `package.json`/`node_modules` from this repo), `dist/.github/atoma/tools/scripts/package.json` declares the one runtime dependency the MCP servers need (`@modelcontextprotocol/sdk`), and `atoma-runner.yml` installs it (scoped to that directory) before running the agent.

```bash
bun install          # install this repo's own dev dependencies
bun run synth        # regenerate dist/.github/workflows/*.yml + copy src/scripts/** into dist/ (gwf build + build-dist.ts)
bun run synth:check  # verify dist/ matches its src/ source (used by .github/workflows/ci.yml)
bun run typecheck    # tsc --noEmit across src/ and dist/.github/atoma/tools/scripts/{mcp,hooks}/
bun run test         # bun:test — script & MCP server behavior tests
bun run lint         # typecheck + synth:check
```

## License

This template is part of the [Atoma](https://github.com/yuma-seno/atoma) project. See [LICENSE](https://github.com/yuma-seno/atoma/blob/main/LICENSE).
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

## Quick Start

### 1. Copy the template

```bash
# Clone your target repository
git clone https://github.com/YOUR_ORG/YOUR_REPO.git
cd YOUR_REPO

# Copy this template's .github directory
curl -L https://github.com/yuma-seno/atoma-autonomous-delivery/archive/main.tar.gz | tar xz --strip=2 "*/atoma-autonomous-delivery-main/.github/"
```

Or simply copy the `.github/` directory from this repository into your own.

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
| `OPENAI_BASE_URL` | — | *(leave empty — defaults to `https://api.openai.com/v1`)* |
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

> **Note:** `GITHUB_PAT_TOKEN` is only required when using the GitHub Copilot provider. For OpenRouter/OpenAI/Anthropic, the auto-generated `GITHUB_TOKEN` is sufficient.

### 3. Create an issue to kick off

Create a new issue with the body:

```
/orchestrator
```

Or add the `atoma/orchestrator` label to any existing issue.

### 4. Sit back

The orchestrator will:
1. Analyze the issue
2. Decompose work into sub-issues (or delegate directly for small tasks)
3. The engineer implements and creates a PR
4. The reviewer inspects and requests changes if needed
5. When the PR is approved, the workflow completes

---

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `atoma-entry.yml` | Issue opened or labeled | Start agents from issue body slash commands or `atoma/*` labels |
| `atoma-manual-comment.yml` | Issue/PR comment | Manually invoke any agent via `/agent-name` in a comment |
| `atoma-reviewer-on-pr.yml` | PR opened/synchronized | Automatically run the reviewer on every PR update |
| `atoma-engineer-on-changes-requested.yml` | PR review submitted | Re-trigger the engineer when a review requests changes |
| `atoma-sub-issue-closed.yml` | Issue closed | Detect sub-issue completion and re-invoke orchestrator |
| `atoma-runner.yml` | (reusable) | Core executor: setup → prepare → run → post-result → dispatch-next |

## Agent Definitions

See `.github/atoma/agent-definitions/`:

- **orchestrator** — Issue intake, decomposition, delegation, aggregation
- **engineer** — Implementation and fixes
- **reviewer** — Quality gate with automatic fix loop

## Orchestration

`.github/atoma/orchestration.json` controls:
- Which agent sees which GitHub events (shared context filtering)
- Dispatch workflow name
- Script configuration (create_pr, push_commits, create_sub_issue dispatch targets)

## Tools

See `.github/atoma/tools/tools.yaml`:

- **filesystem** — Read/write access (engineer only). `directory_tree` and `search_files` are denied.
- **filesystem_readonly** — Read-only access (orchestrator, reviewer)
- **shell** — Command execution (guarded by `shell_guard.py`)
- **github** — GitHub API access via MCP

## Session Persistence

Agent memory is stored in an orphan Git branch called `atoma-data` within your repository. This branch is automatically created on first use and persists across workflow runs without relying on GitHub Cache (which expires after 7 days).

## Resource Estimates

| Model | ~Prompt tokens | ~Completion tokens | ~Cost |
|---|---|---|---|
| DeepSeek V4 Flash (default) | 15,000–50,000 | 1,000–5,000 | $0.005–$0.010 |

Costs scale with issue complexity. Token usage and cost are displayed in each result comment.

---

## License

This template is part of the [Atoma](https://github.com/yuma-seno/atoma) project. See the [LICENSE](https://github.com/yuma-seno/atoma/blob/main/LICENSE).
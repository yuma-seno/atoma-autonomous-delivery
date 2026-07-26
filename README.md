# Atoma Autonomous Delivery

Atoma Autonomous Delivery is a copyable GitHub Actions delivery system powered by Atoma, not Atoma core itself.

## What you get

After adoption, opening or updating an issue/PR can trigger an agent run that:

- restores per-agent session context
- runs Atoma with your configured agent/tools/skills
- comments results back on the issue/PR
- dispatches the next agent when a handoff directive is present

## Shortest adoption path

Copy the deliverable workflow assets from this repository into your repository:

```bash
# from this repository root
TARGET=/path/to/your-repo
mkdir -p "$TARGET/.github"
cp -R dist/.github/. "$TARGET/.github/"
```

Then commit in your target repository.

## Preflight checklist

Required before first run:

- GitHub Actions enabled in the target repository.
- Repository secret for at least one model path:
  - `OPENAI_API_KEY` (OpenAI-compatible path), or
  - `ANTHROPIC_API_KEY` (Anthropic path).
- Repository labels named `atoma/in-progress`, `atoma/sub-issue`, and `atoma/launched`.
- Optional repository variables:
  - `OPENAI_BASE_URL`
  - `ATOMA_PROVIDER` (`openai` or `anthropic` with the credentials wired by this template)

Workflow permissions are already declared in the generated workflows (`actions`, `issues`, `pull-requests`, `contents` set to write where needed).

## First issue and success criteria

Create an issue whose first non-blank line is a slash command, for example:

```text
/orchestrator

Build a plan to split this task into sub-issues.
```

Observable success criteria:

- `Atoma Entry` routes to `atoma-runner`.
- The issue gets the `atoma/in-progress` label while running.
- The agent posts a result comment or performs a visible handoff/tool action.

## Lifecycle

```mermaid
flowchart TD
    A[GitHub event or slash command] --> B[Routing workflow]
    B --> C[atoma-runner reusable workflow]
    C --> D[Restore session from atoma-data]
    D --> E[Run Atoma agent]
    E --> F[Post result and save session]
    F --> G{Directive or tool-triggered dispatch?}
    G -->|Yes| C
    G -->|No| H[Release in-progress guard]
```

## Choose your path

- Customization contract and recipes: [docs/customization.md](docs/customization.md)
- Runtime operations and troubleshooting: [docs/operations.md](docs/operations.md)
- Contributing to this template repository: [CONTRIBUTING.md](CONTRIBUTING.md)
- Atoma core CLI/runtime docs: https://github.com/yuma-seno/atoma

## Limits, security, and cost notes

- Auto-dispatch loop is capped at 5 consecutive no-new-event handoffs.
- Session serialization per issue/PR is guarded by the `atoma/in-progress` label and workflow concurrency group.
- The shell guard is a denylist-based command filter, not a full sandbox.
- Some workflows use `pull_request_target`, which runs with base-repository privileges. Review your repository policy for third-party PRs.
- The current `pull_request_review` route does not forward repository secrets to the reusable runner. Wire explicit secrets or `secrets: inherit` before relying on review-submitted dispatches with API-key providers.

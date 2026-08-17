# Customization

This guide separates two workflows clearly:

- You are adopting the generated deliverable in your own repository.
- You are changing this template repository itself.

## Contents

- [Source vs deliverable](#source-vs-deliverable) — which files you edit, and which are generated
- [`config.json` contract](#configjson-contract) — every supported field, and [which file a setting belongs in](#which-file-a-setting-belongs-in)
- [Upgrading an adopted repository](#upgrading-an-adopted-repository)
- [Regenerate and deploy changes](#regenerate-and-deploy-changes)

Task-oriented recipes:

| Recipe | You want to |
| --- | --- |
| [Change model per agent](#change-model-per-agent) | run an agent on a different model |
| [Let an agent read images](#let-an-agent-read-images) | have a screenshot reach the agent as a picture |
| [Choose which API an agent's provider speaks](#choose-which-api-an-agents-provider-speaks) | switch between the Chat Completions and Responses APIs |
| [Pin which OpenRouter endpoint serves a model](#pin-which-openrouter-endpoint-serves-a-model) | prefer particular upstream providers |
| [Change iteration budget](#change-iteration-budget) | let an agent think for longer, or less |
| [Change event triggers](#change-event-triggers) | decide which GitHub events start which agent |
| [Add environment setup commands](#add-environment-setup-commands) | install your project's toolchain before an agent runs |
| [Choose the branch agents work from](#choose-the-branch-agents-work-from) | target something other than the default branch |
| [Work with decomposed issues](#work-with-decomposed-issues) | understand how sub-issue branches stack |
| [Point Atoma at your own workflows](#point-atoma-at-your-own-workflows) | have agents start your CI and deployment |
| [Set up CI and deployment](#set-up-ci-and-deployment) | give a repository a pipeline an agent can write and maintain |
| [Requiring a check that agents can satisfy](#requiring-a-check-that-agents-can-satisfy) | make required checks work with agent merges |
| [Changes an agent may not merge](#changes-an-agent-may-not-merge) | keep some paths for human review |
| [Give a tool a credential](#give-a-tool-a-credential) | let a tool server reach something outside GitHub |
| [Search this repository's issues](#search-this-repositorys-issues) | tune or replace the issue search model |
| [Let agents read the web](#let-agents-read-the-web) | change or remove web fetching and search |
| [What a shell command may print](#what-a-shell-command-may-print) | control shell output limits |
| [Rename labels](#rename-labels) | use your own label names |
| [Change merge behavior](#change-merge-behavior) | require a human to merge |
| [Customize prompt template](#customize-prompt-template) | change what every agent is told |
| [Customize skills and tools](#customize-skills-and-tools) | add a skill or an MCP server |

## Source vs deliverable

In this repository:

- `src/` is hand-authored source.
- `dist/.github/` is generated deliverable output. Not tracked in git — `bun run
  synth` builds it, and a release publishes it as `atoma-delivery.zip`.

In your adopted repository:

- `.github/` is the runtime copy that workflows execute.

If you only customize your own repository, edit your copied `.github/atoma/*` files directly.

## `config.json` contract

Primary file: `.github/atoma/config.json`

Supported top-level fields used by scripts/workflows:

- `merge_policy`
- `base_branch`
- `governed_paths`
- `environment.setup_commands`
- `agents.<name>.max_iterations`
- `labels.in_progress`, `labels.sub_issue`, `labels.launched`
- `workflows.ci`, `workflows.cd`
- `search.reranker_model`
- `checks.commands`, `checks.secrets`
- `deploy.targets`, `deploy.secrets`
- `tools.secrets`
- `auto_triggers[]` with `event`, `agent`, optional `condition`

Credentials are declared under the feature that consumes them, not in one list
for the repository. `tools.secrets` reaches the agent's own process and nothing
else does; a credential for somewhere else belongs beside whatever runs there.
The nesting is the boundary, so keep it — collapsing these into a single list
would put every credential in every destination.

`config.json` is **yours**. Everything else under `.github/atoma/` is generated and
is replaced when you upgrade the template; this file is not, so edits to it
survive. Keep project-specific settings here rather than in repository variables,
where they are neither versioned nor reviewable.

### Which file a setting belongs in

The line follows what the setting is *about*, not which file is more convenient to
edit:

- **`config.json` — the delivery system.** How agents coordinate with each other
  and with GitHub: which event dispatches which agent, the labels used to track
  work, the merge policy, the workflows to dispatch, the environment a run needs.
- **The agent definition — one agent.** What that agent *is*: its model and
  provider, the tools it may use, the colleagues it knows about, who may call it,
  and its role prompt.

This is not an invention of this template. The agent definition is Atoma's own
contract and is validated by `atoma validate`; `config.json` is the delivery
layer's. Keeping them apart means an agent definition stays portable — it describes
an agent, not a delivery pipeline.

`agents.<name>.max_iterations` is the one entry that looks like an exception. It is
per-agent yet lives in `config.json`, because it is a budget the runner imposes on
a run rather than part of what the agent is — Atoma has no such field, it is a CLI
flag the runner supplies.

Resist moving a setting across this line for operational convenience. Wanting to
avoid an upgrade conflict is not a reason to describe an agent's model as delivery
configuration; fix the upgrade procedure instead.

Supported trigger conditions:

- `changes_requested`
- `non_draft`

The `atoma:dispatch` entry in the shipped config is reserved for comments generated by the delivery system. The manual-comment workflow parses that dispatch marker directly; it is not a general condition evaluated by `match_trigger.ts`.

## Upgrading an adopted repository

There is no upgrade command, and a copy is not one. The deliverable contains two
kinds of file, and only you can say which of your edits are deliberate:

| Path | Yours to edit? |
| --- | --- |
| `.github/scripts/**`, `.github/workflows/**`, `.github/atoma/tools/scripts/**` | No — generated code, replace wholesale |
| `.github/atoma/config.json` | Yes — most settings live here on purpose |
| `.github/atoma/skills/project/**` | Yes — your own skills, the template ships none |
| `.github/atoma/agent-definitions/**`, `skills/**`, `prompt-template.md`, `tools/tools.yaml`, `mcp-packages.json` | Both — the template ships defaults it also expects you to tune |

That last row is the awkward one, and no script can resolve it: a difference there
is either an improvement you have not taken yet or a change you made on purpose,
and the files look identical either way.

So treat it as vendoring, and let git do the merge:

```bash
gh release download v0.1.1 -R yuma-seno/atoma-autonomous-delivery -p atoma-delivery.zip
unzip -o atoma-delivery.zip   # the archive holds .github/, so run this at the repo root
rm atoma-delivery.zip
git diff .github/            # every difference is now a decision
git checkout -- .github/atoma/config.json    # for anything you meant to keep
```

Name the version rather than taking `latest`. Recording which release you adopted
is what lets you read the upstream changes between it and the next one
(`gh release view`, or compare the two tags) instead of rediscovering them in a
diff. Extracting also never deletes: a file the template dropped upstream stays in
your tree, so a disappearance shows up as an upstream change you have to notice
yourself rather than as a deletion in `git diff`.

Review that diff rather than trusting the copy. The safest habit is to keep your
customisation where the template will not fight you for it — `config.json` covers
models' iteration budgets, labels, triggers, merge policy, environment setup and
workflow names, and `skills/project/` is yours outright.

## Task-oriented recipes

### Change model per agent

Edit `.github/atoma/agent-definitions/<agent>.md` and update the frontmatter `model` field.

### Let an agent read images

An agent gets pictures from a tool only when its definition says so:

```yaml
vision: true
```

Set it when the model reads images, and leave it off when it does not. Without
it, a tool that returns a picture delivers text in its place saying the image was
withheld and naming this setting — so a model that could have read one tells you,
instead of the picture disappearing.

The default is off because the two mistakes cost differently. Sending a picture
to a text-only model is an API error that loses the run; withholding one from a
model that could have read it costs a single tool result, and says why.

Check the model before setting it. On OpenRouter:

```bash
curl -s https://openrouter.ai/api/v1/models/<author>/<slug>/endpoints \
  | grep -o '"input_modalities":\[[^]]*\]'
```

The shipped agents are set this way: the reviewer and orchestrator read images,
the engineer does not.

### Choose which API an agent's provider speaks

The frontmatter `provider` field selects the client, not the vendor:

| Value | API |
| --- | --- |
| `openai` | Chat Completions (`/chat/completions`) — the default, and what OpenAI-compatible servers speak |
| `openai-responses` | OpenAI's Responses API (`/responses`) |
| `anthropic` | Anthropic Messages |
| `github-copilot` | Copilot, over Chat Completions |

The two OpenAI entries reach the same models by different routes. Prefer
`openai` unless you need the other: it is what vLLM, Ollama, LM Studio, Azure and
every gateway built to that shape accept, so it is the one that keeps your choice
of host open.

`openai-responses` earns its place in one case — **a tool that returns an
image**. Chat Completions cannot carry a picture in a tool result at all, so on
that route the image is moved into a following message; the Responses API's
`function_call_output` takes it directly. If your agents never receive pictures,
the two behave alike and `openai` is the safer default.

Both read `OPENAI_API_KEY` and `OPENAI_BASE_URL`. Point `OPENAI_BASE_URL` at a
host that serves the endpoint you picked — not every OpenAI-compatible gateway
implements `/responses`.

### Pin which OpenRouter endpoint serves a model

Agent definitions ship an `extra_body.provider` block. Atoma merges every
`extra_body` key straight into the request body, so this is OpenRouter's own
provider-routing contract rather than an Atoma feature:

```yaml
extra_body:
  provider:
    order:
      - Xiaomi
      - Parasail
      - Novita
```

Note this is unrelated to the top-level `provider:` field, which selects Atoma's
client (`openai`/`anthropic`/`github-copilot`).

Why it is set: `order` puts the endpoints with the best uptime first, while
OpenRouter stays free to route elsewhere.

**Do not add `allow_fallbacks: false` or `require_parameters: true`.** They look
like the natural way to make `order` binding, and they break every request. With
either set alongside the `openrouter:web_search`/`web_fetch` server tools the
agents declare, every run fails on its first inference call with
`Server tool request failed` (HTTP 404, `provider_name: null`). Server tools are
executed by OpenRouter above provider selection, and no endpoint advertises them in
`supported_parameters`, so hard-pinning the route leaves that layer nowhere to
dispatch. Keep this list advisory.

A single unhealthy endpoint shows up as hung requests, truncated response
bodies, and contentless completions. List current endpoints and their uptime with:

```bash
curl -s https://openrouter.ai/api/v1/models/<author>/<slug>/endpoints
```

Adjust `order` whenever you change `model`, since the endpoint names are
per-model.

### Change iteration budget

Edit `.github/atoma/config.json`:

```json
{
  "agents": {
    "engineer": { "max_iterations": 120 }
  }
}
```

### Change event triggers

Edit `auto_triggers` in `config.json`.

Example:

```json
{
  "auto_triggers": [
    { "event": "pull_request.opened", "agent": "reviewer" },
    { "event": "pull_request_review.submitted", "agent": "engineer", "condition": "changes_requested" }
  ]
}
```

### Add environment setup commands

Add shell commands to `environment.setup_commands`. They run before `atoma run` through `bash -c`, in order, and stop on first failure.

Agents are told to treat the runner as already provisioned and never to spend
iterations installing or configuring tooling themselves, so anything they need at
run time belongs here. The template ships it empty on purpose: it is
language- and framework-agnostic, and only you know what your project needs.

(This guidance previously lived in an `environment.description` field inside
`config.json`. Nothing ever read it — JSON has no comments, so prose in a config
file is invisible to both the code and the agents. It is documentation, so it
lives in the documentation.)

### Choose the branch agents work from

```json
{
  "base_branch": "develop"
}
```

Agents branch from this and open their pull requests against it. Leave it unset
and both fall back to the repository's default branch, which is what a repository
developing on `main` wants.

Set it if you develop on an integration branch and release by merging that branch
elsewhere — `develop` → `main`, say. Without it every agent pull request aims at
`main`, so ordinary work lands straight in what you release from.

#### Release pull requests

Atoma has no notion of a release: the promotion pull request — `develop` into
`main`, or whatever your equivalent is — is yours to open, from the GitHub UI or
`gh pr create --base main --head develop`. It carries the merge of many issues and
is where you decide a set of work is ready to ship, which is a judgement no agent
is positioned to make.

Nothing about that pull request is special to Atoma. It is reviewed by whoever
reviews releases, and merging it runs whatever your `main` branch already runs.

### Work with decomposed issues

When an issue is decomposed into sub-issues, the work stacks on branches
instead of landing on the base branch one piece at a time:

- Each sub-issue's branch is cut from its parent issue's branch and merges back
  into it, so siblings see each other's work as it lands.
- The parent's branch is created from the base branch when the first child
  commits; until then it does not exist.
- Once every child is done, the parent's branch becomes one pull request into
  the base branch.
- A merge into a parent branch runs no deployment — the work is still in
  progress, and only the final pull request into the base branch carries it to
  release.

### Point Atoma at your own workflows

Most projects should not need this. The default is
[a pipeline written as commands](#set-up-ci-and-deployment), which an agent can
author and maintain; naming a workflow of your own opts back out of that. Reach
for it when the pipeline needs something commands cannot express — the four
cases are listed in that section.

```json
{
  "workflows": {
    "ci": "ci.yml",
    "cd": "deploy.yml"
  }
}
```

`ci` is the workflow Atoma runs against an agent's pull request before anyone
reviews it. Defaults to `atoma-check.yml`. Name yours here, exactly as the file
is called, or the dispatch fails silently and every merge is refused for a
missing check.

Its result decides what happens next: the reviewer is dispatched when it passes,
the engineer when it fails. See below for what that workflow has to support.

`cd` is dispatched after a successful merge — required rather than optional if
your deployment is chained off CI or off a push to the base branch. An agent
merge is performed with `GITHUB_TOKEN`, and GitHub starts no workflow run for
events its own token triggers, so nothing downstream of that merge fires by
itself and your deployment would silently never run. Defaults to
`atoma-deploy.yml`, which does nothing when no target deploys on merge.

### Set up CI and deployment

You can point Atoma at workflows you wrote, as above. Or you can write no
workflow at all and describe the pipeline as commands:

```json
{
  "checks": {
    "commands": ["bun install --frozen-lockfile", "bun run typecheck", "bun test"]
  },
  "deploy": {
    "targets": [
      { "name": "staging", "on": "merge", "commands": ["./scripts/deploy.sh staging"] },
      { "name": "production", "on": "tag", "tags": ["v*"], "commands": ["./scripts/deploy.sh prod"] }
    ]
  }
}
```

Two shipped workflows run these — `atoma-check.yml` and `atoma-deploy.yml`.
Neither changes per project, which is the whole point: **an agent can write
configuration and cannot write a workflow.** GitHub refuses `GITHUB_TOKEN` on
`.github/workflows/**` by identity, on every path and every branch, and no
permission grants it. So a repository whose pipeline lives in `config.json` is
one an agent can set up, extend and repair; one whose pipeline lives in workflow
YAML always needs a person.

Nothing needs pointing at these — `atoma-check.yml` and `atoma-deploy.yml` are
what `workflows.ci` and `workflows.cd` default to. Fill in the commands and they
run.

Until you do, the check passes and says so as a warning: it is the required
check, so an empty `checks.commands` means a pull request satisfied something
that tested nothing. Failing instead would block every pull request from the
moment you adopt Atoma.

**Triggers.** `on` is `merge` (a change landing on your default branch, whether an
agent merged it or you did), `tag` (a pushed tag matching `tags`, which is a
literal or a prefix followed by `*`), or `manual`. Any target can also be
dispatched by name whatever its trigger, which is what makes a `manual` rollback
target worth declaring. A tag no target claimed exits cleanly rather than failing,
so tagging for other reasons costs you a few seconds and no red run. Schedules are
not supported: a cron expression can only be written in a workflow's `on:`, so it
cannot come from configuration.

`on: merge` reaches your default branch if it is called `main` or `master`. A
workflow's `on:` cannot say "the default branch", so those two are listed
literally and then narrowed to the branch your repository actually defaults to. If
yours is named something else, an agent's merge still deploys — that path is an
explicit dispatch, not an event — but your own merges will not, and
`workflows.cd` is the way to cover them.

**Credentials** go in the list belonging to whatever needs them — `checks.secrets`
or `deploy.secrets`, alongside `tools.secrets`. Add the secret to the repository
first; these name it, they do not create it. Inside a deployment,
`$ATOMA_DEPLOY_TARGET` holds the target's name. `atoma-deploy.yml` declares
`id-token: write`, so a cloud provider's OIDC login works and is worth preferring
over storing a long-lived key at all.

**What commands cannot express**, and where you still need a workflow of your own
through `workflows.cd`:

- a job's `permissions` beyond what the shipped workflows declare. `atoma-check.yml`
  runs with `contents: read` plus a `GITHUB_TOKEN` in `GH_TOKEN`;
  `atoma-deploy.yml` with `contents: write` and `id-token: write`, so it can cut a
  release and can exchange its identity for cloud credentials
- a deployment approval gate — `environment:` takes no expression, so nothing in
  configuration can reach it
- GitHub's own artifact store and cache
- any trigger outside merge, tag and manual dispatch — including a default branch
  named neither `main` nor `master`, for your own merges

Most of the limits people expect are not real. Service containers work through
`docker run`, and a matrix works as a loop, losing only parallelism. Both are
commands.

**The required check is a matched pair.** `.github/atoma/rulesets/main.json`
ships requiring the context `atoma-check`, which is the job name in
`atoma-check.yml`. Apply it with:

```bash
gh api repos/{owner}/{repo}/rulesets --input .github/atoma/rulesets/main.json
```

Do not rename one side without the other. A ruleset requiring a context no job
produces does not fail a pull request — it leaves it waiting forever on a check
that will never report, and re-running nothing fixes it.

### Requiring a check that agents can satisfy

A branch ruleset that requires a status check is the normal way to keep unreviewed
work off your default branch, and it is worth keeping. It applies to agents
exactly as it applies to you — nothing here asks you to exempt them.

Two conditions make it work.

**The workflow producing the check must accept `workflow_dispatch`.** Keep
whatever triggers you already have; just add that one:

```yaml
on:
  pull_request:      # keep it — this is what serves humans and forks
  workflow_dispatch: # add it — this is how Atoma runs the same workflow
```

Atoma starts that workflow itself for an agent's pull request, waits for it, and
publishes the result. A workflow it cannot start leaves the required check
unfilled, and the pull request can never merge.

**Only require checks from workflows Atoma can start.** Contexts that come from
somewhere else — a coverage service, a scanner, a workflow written for
`pull_request` alone — cannot be filled on an agent's pull request. Either drop
them from the ruleset's required list or give them a `workflow_dispatch` trigger
too.

Set required approvals to **0**. Atoma's agents share one bot identity and GitHub
forbids self-approval, so requiring even one review deadlocks every agent pull
request.

#### What you will see, and what not to touch

An agent's pull request carries a workflow run stuck at `action_required`,
showing as a pending check that nobody approves. **Leave it there.** GitHub holds
it because the pull request was opened with `GITHUB_TOKEN`, and the merge does not
depend on it: the check Atoma publishes is what satisfies the ruleset, and the
pull request settles at `UNSTABLE`, which a ruleset permits.

Deleting that held run is the tempting cleanup and it is destructive. It breaks
the commit's check rollup in a way no re-run repairs, and the pull request becomes
permanently unmergeable. If the pending entry bothers you, approve it.

#### If your workflow reads pull request context

A `workflow_dispatch` run has no `github.event.pull_request`. A step that reads
the PR number or its diff from the event payload gets nothing when Atoma starts
it. Resolve it from the branch instead:

```bash
PR=$(gh pr list --head "$GITHUB_REF_NAME" --state open --json number --jq '.[0].number // empty')
```

### Changes an agent may not merge

An agent will not merge a pull request that changes how agents run. It reviews it
and reports, and the merge is yours.

Covered by default:

```text
.github/**
```

That is where an agent's limits live — which credentials reach a run, the scripts
the runner executes to decide when a run may continue, which commands the shell
hook refuses, what a ruleset requires before a merge. An agent that could merge a
change to them could widen its own reach, and nothing later catches it, because
the next run already obeys the new file.

This is not about an agent intending to. A prompt injection carried in an issue
body reaches exactly as far, and so does an ordinary mistake. Both stop at a
person reading the diff.

The whole directory rather than the parts of it that obviously matter. An earlier
default named four subdirectories and left out `.github/scripts/**`, which is
where the runner's own control logic lives — nothing decided that, the list was
simply written before the directory existed. A list of the paths that count has
to be revisited every time the tree grows, and gives no sign when it has not been.

Narrow it, or extend it, with `governed_paths`, which replaces the default:

```json
{
  "governed_paths": [
    ".github/**",
    "infra/**"
  ]
}
```

Set it to `[]` to turn the gate off.

If you deliberately want a corner of `.github/` back — issue templates, say —
name the parts you do want governed instead. Prefer that to a narrower default:
being explicit about the exception leaves a record of the decision.

Note what this does *not* do. The provider API key and `GITHUB_TOKEN` are in the
agent's own environment because the run needs them to work at all, and no setting
moves them out.

Every other repository secret stays outside that environment until you name it.
Nothing reaches an agent by being a secret; it reaches an agent by being
declared, and the declaration is in a file this gate already covers — see
[Give a tool a credential](#give-a-tool-a-credential).

### Give a tool a credential

A tool server that talks to something outside GitHub needs one — a Slack token,
an API key for your issue tracker. Add the secret to the repository the usual
way, then name it in `config.json`:

```json
{
  "tools": { "secrets": ["SLACK_TOKEN"] }
}
```

That is the whole change. You are naming a secret that already exists, not
creating one, and you never edit a workflow: `atoma-runner.yml` is generated
upstream and reaches your secrets through a key it learns at run time.

Each named secret is exported under its own name before any tool server starts,
and servers inherit the environment they are spawned in, so a server that reads
`SLACK_TOKEN` needs nothing further. A server that wants the value under a
different name is what `tools.yaml`'s `env:` is for — but note those values are
literal, with no `${...}` expansion, so the simplest arrangement is to name the
repository secret whatever the server already looks for.

Be deliberate about this list. It is the one setting that widens what an agent
can read, and an agent reads issue text written by anyone who can open an issue.
A credential named here is reachable by a prompt injection exactly as it is
reachable by the tool you added it for. The shell hook and
[redaction](#what-a-shell-command-may-print) reduce what leaves a run; neither
makes a credential safe to hand over casually. Name the ones a tool genuinely
needs, and nothing else.

**Every credential list is read from your default branch**, whichever branch a
run is otherwise working on. A pull request can change what a run *does* — that
is the change under test — but not which of your secrets it is handed. Adding a
name therefore takes effect once it is merged, not while the pull request that
adds it is being reviewed. That is deliberate: without it, opening a pull request
would be enough to choose what the run reviewing it can read.

Four things fail the run rather than being quietly dropped, because a credential
that was asked for and silently not delivered surfaces much later as a tool
failure pointing nowhere near the cause:

- a name that is not shaped like an environment variable (`SLACK_TOKEN`, not
  `slack_token` or `Slack-Token`)
- a name the run already uses for itself, such as `GH_TOKEN` or
  `OPENAI_API_KEY` — declaring one would replace the run's own value rather than
  add a credential
- the same name twice
- more than ten names, which is the number of slots the generated workflow
  carries; raising it needs a new release

Naming a secret the repository does not actually have is a warning rather than a
failure. The run itself is unaffected, and only the tool needing that value will
fail — with the reason already in the log.

### Search this repository's issues

`search__search_issues` answers a question from the issues and their discussion,
and returns which passage answered it — `matched_in: "comment 3"` — so the caller
can read that comment with `github__get_issue_comments(number=..., from=3)`
rather than pulling a whole conversation in.

Nothing needs configuring for this to work. The index is built on the first
search, stored on the `atoma-data` branch, and brought up to date on each
call by asking GitHub only for what changed.

Two stages produce the ranking. A lexical first stage casts a wide net over
every passage; a cross encoder then reads the twenty issues it caught and
decides which of them actually answers the question. Only the second stage is
configurable, because measurement put the whole difference there — enlarging
the reranker moved top-1 accuracy from 27% to 91%, while adding a dense vector
index alongside the first stage changed no ranking at all.

```json
{
  "search": {
    "reranker_model": "onnx-community/bge-reranker-v2-m3-ONNX"
  }
}
```

The default is multilingual and about 600MB, downloaded once per runner and
cached after that. Name a smaller cross encoder here if that cost matters more
than ranking quality, or a language-specific one if your issues are all in one
language. Any model the runner can load as a sequence-classification cross
encoder works; the search still functions if it fails to load, falling back to
the first stage's own order.

**The question's language matters.** The first stage matches characters rather
than meaning, so a question asked in a language the issues are not written in
scores near zero and never reaches the cross encoder. Agents are told this in
the tool's own description.

### Let agents read the web

`web__fetch` retrieves a URL and returns the page as Markdown, so an agent gets
prose rather than markup; `raw: true` returns the markup, and a URL that
resolves to an image comes back as an image for agents with `vision: true`.

Searching is a skill rather than a tool. `.github/atoma/skills/research/web-search.md`
tells agents to fetch a search engine's results page and read the links out of
it. The endpoint lives in that file on purpose:

- To use a different service — one with an API key, or your own instance —
  edit the skill. The tool fetches whatever URL it is handed, so nothing else
  changes.
- To stop agents querying a public search engine at all, delete that section of
  the skill. Fetching a page whose address is already known keeps working.
- To remove web access entirely, drop `web` from `mcp_servers` in the agent
  definitions that name it, and from `tools.yaml`.

### What a shell command may print

A shell command's output is redacted before the agent, the run log, the session,
or an issue comment ever sees it. Two things are removed: text shaped like a
vendor credential (`sk-`, `ghp_`, `AKIA`, a PEM header, and similar), and the
exact values of the API key and tokens the run itself holds.

This is a net, not a control. A value *derived* from a secret — a slice of a key,
a base64 of one — is indistinguishable from ordinary text and gets through. Keep
secrets your agents do not need out of their environment, and treat this as the
thing that catches the accident rather than the thing that makes it safe.

It exists because two of the three places a run's output lands are otherwise
unprotected: GitHub Actions substitutes `***` for registered secrets in the
workflow log, and does nothing for the issue comment a run posts or for the
session JSON on the `atoma-data` branch.

### Rename labels

Set `labels.in_progress`, `labels.sub_issue`, and `labels.launched` in `config.json`.

Keep names consistent with your repository label taxonomy.

### Change merge behavior

Set `merge_policy` in `config.json`.

Current code path reads this value for merge decisions in GitHub MCP tooling.

### Customize prompt template

Edit `.github/atoma/prompt-template.md`.

This file is passed to Atoma with `--template` on every runner invocation.

### Customize skills and tools

- Skills live under `.github/atoma/skills/**/*.md`.
- Tool server config lives in `.github/atoma/tools/tools.yaml`.
- Tool scripts and MCP servers live under `.github/atoma/tools/scripts/`.

Dynamic skill behavior:

- Skill metadata is listed in prompt context.
- Full skill body is loaded only when agent calls `atoma_builtin__load_skill`.

## Regenerate and deploy changes

If you are modifying this template repository:

1. Edit `src/` files.
2. Commit only that. `dist/` is not tracked, so there is nothing generated to
   commit — see CONTRIBUTING.md.
3. Run `bun run synth` locally whenever you want to see what adopters will
   receive.
4. Adopters receive it when a release is cut from a version tag, not on merge.

If you are only adopting in your own repository:

1. Edit your copied `.github/` runtime files.
2. Commit and run workflows in that repository.

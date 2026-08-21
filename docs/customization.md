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
| [Limit how far agents hand work to each other](#limit-how-far-agents-hand-work-to-each-other) | stop an engineer/reviewer loop that is going nowhere |
| [Change event triggers](#change-event-triggers) | decide which GitHub events start which agent |
| [Add environment setup commands](#add-environment-setup-commands) | install your project's toolchain before an agent runs |
| [Choose the branch agents work from](#choose-the-branch-agents-work-from) | target something other than the default branch |
| [Work with decomposed issues](#work-with-decomposed-issues) | understand how sub-issue branches stack |
| [Point Atoma at your own workflows](#point-atoma-at-your-own-workflows) | have agents start your CI and deployment |
| [Set up CI and deployment](#set-up-ci-and-deployment) | give a repository a pipeline an agent can write and maintain |
| [What a pull request is checked against](#what-a-pull-request-is-checked-against) | understand the check that runs before your CI |
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
| [What a tool can and cannot be protected from](#what-a-tool-can-and-cannot-be-protected-from) | know which credentials a tool server can reach |
| [Adding a tool without flooding the context](#adding-a-tool-without-flooding-the-context) | keep a new tool from filling the model's context window |
| [How long your tool has to answer](#how-long-your-tool-has-to-answer) | let a tool run longer than a minute, or find out why it did not |
| [If your tool does time out](#if-your-tool-does-time-out) | know what a server must do when a call is abandoned |
| [Recurring work](#recurring-work) | have something happen every week without a schedule setting |

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

Every setting Atoma reads, one per line. A key that is not on this list is not
read by anything — so a typo silently does nothing, which is why the pull request
that introduces one now fails: see [What a pull request is checked
against](#what-a-pull-request-is-checked-against).

- `merge_policy`
- `base_branch`
- `governed_paths`
- `merge_gates` — a list, each entry with `reason` and `when`
- `environment.setup_commands`
- `agents.<name>.max_iterations`
- `limits.agent_handoffs`
- `labels.in_progress`
- `labels.sub_issue`
- `labels.launched`
- `workflows.ci`
- `workflows.cd`
- `search.reranker_model`
- `checks.commands`
- `checks.secrets`
- `deploy.targets`
- `deploy.secrets`
- `tools.secrets`
- `auto_triggers` — a list, each entry with `event`, `agent`, optional `condition`

`labels` also accepts names of your own beyond the three above.

This list is held to the code by `tests/contract/config-contract.test.ts`, which
compares it against the same schema the validator uses. It was a fourth copy of
the same fact — the interface in `lib/types.ts`, the runtime schema, the readers
in `lib/config.ts`, and this — with nothing keeping them in step.

Credentials are declared under the feature that consumes them, not in one list
for the repository. The nesting is the boundary, so keep it — collapsing these
into a single list would put every credential in every destination.

| Layer | Decides | Lives in |
| --- | --- | --- |
| Repository secrets | the value | Settings |
| `checks.secrets` / `deploy.secrets` / `tools.secrets` | whether that destination may hold it | `config.json` |
| `env: ${NAME}` | which tool server receives it | `tools.yaml` |

The third row applies to `tools.secrets` only, and it is easy to miss:
authorising a credential does not deliver it. `checks` and `deploy` need no
routing step, because their commands run in a workflow of their own rather than
beside an agent. See [Give a tool a credential](#give-a-tool-a-credential).

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

- `changes_requested` — the review that fired this event requested changes
- `non_draft` — the pull request is not a draft

The `atoma:dispatch` entry in the shipped config is reserved for comments
generated by the delivery system. `atoma-manual-comment.yml` parses that marker
out of the comment body directly, so the entry documents a path rather than
selecting an agent: it never matches here, whatever agent it names.

**A condition that is not one of these is an error.** It used to be ignored,
which was worse than it sounds: the matcher asked "do I know a reason to skip
this entry?" rather than "does this entry apply?", so an unrecognised condition
was not a trigger that never fires — it was a trigger that fires **every time**.
A `non_draft` mistyped as `nondraft` dispatched an agent onto every draft pull
request, and the author of the typo had every reason to believe the opposite.
The whole list is rejected, for the same reason `merge_gates` rejects one: a
partly-honoured trigger list dispatches some agents and silently not others.

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

| Value | API | Credential | Endpoint |
| --- | --- | --- | --- |
| `openai` | Chat Completions (`/chat/completions`) | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `openai-responses` | OpenAI's Responses API (`/responses`) | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `openrouter` | Chat Completions | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `openrouter-responses` | Responses | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `orcarouter` | Chat Completions | `ORCAROUTER_API_KEY` | `https://api.orcarouter.ai/v1` |
| `orcarouter-responses` | Responses | `ORCAROUTER_API_KEY` | `https://api.orcarouter.ai/v1` |
| `anthropic` | Anthropic Messages | `ANTHROPIC_API_KEY` | `https://api.anthropic.com` |
| `github-copilot` | Copilot, over Chat Completions | `ATOMA_COPILOT_TOKEN` | `https://api.githubcopilot.com` |

**One provider, one credential, and the credential is what selects the provider**
when neither the agent definition nor the `ATOMA_PROVIDER` variable names one. Add
exactly the secret for the provider you intend to use. Adding two is an error naming
both, rather than a precedence that picks for you — before atoma v0.1.13,
`OPENAI_API_KEY` selected a client whose endpoint defaulted to OpenRouter, so the
name of the secret said nothing about where the key was sent.

Each endpoint moves with its own `*_BASE_URL` variable (`OPENROUTER_BASE_URL` and so
on). None of them may be declared in `tools.secrets`: moving a provider's endpoint is
a way to send its credential somewhere else.

The two OpenAI entries reach the same models by different routes. Prefer
`openai` unless you need the other: it is what vLLM, Ollama, LM Studio, Azure and
every gateway built to that shape accept, so it is the one that keeps your choice
of host open.

The Responses variants earn their place in one case — **a tool that returns an
image**. Chat Completions cannot carry a picture in a tool result at all, so on
that route the image is moved into a following message; the Responses API's
`function_call_output` takes it directly. If your agents never receive pictures,
the two behave alike and `openai` is the safer default.

Each pair reads one credential and one endpoint variable, because a pair is one
vendor reached two ways. The `openai` pair is also how to reach a provider with no row
of its own: point `OPENAI_BASE_URL` at any host serving the endpoint you picked — not
every OpenAI-compatible gateway implements `/responses`.

What you give up by doing that instead of naming a provider is that the run's log says
`openai`, so where it went is only visible in the variable. **This repository's own
agent definitions were that case**, reading `provider: openai-responses # openrouter`
— and the trailing comment was there because the name did not say where the request
went. They name `openrouter-responses` now.

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

This bounds the tool-call loop **inside one run**, and it resets on every run. So
every path that starts a run — a handoff to the next agent, an `auto_triggers`
entry, a CI failure sending a pull request back — gives the work a fresh budget.
For how far the chain of runs itself may go, see below.

### Limit how far agents hand work to each other

```json
{
  "limits": {
    "agent_handoffs": 5
  }
}
```

An agent finishing its turn can name the next one, and that one can name another.
Left alone, an engineer and a reviewer will pass a pull request back and forth for
as long as each keeps finding something. This is where that stops and a person is
asked.

Counted from the target's own comments: how many agent result comments there are
since the last comment **a person** wrote. Nothing is stored, so a re-dispatch, a
new workflow run or a lost session does not reset it.

Five is the default. It is chosen against a repository where a person intervenes
often — the longest chain measured was three — so **running autonomously you will
want a larger number**, and wanting closer supervision a smaller one. `0` means the
default rather than "no handoffs"; to stop automatic work entirely, remove the
`auto_triggers` entries, which says so plainly.

**An issue and a pull request are counted separately.** A chain that opens a pull
request starts again from zero, because opening one is progress — the limit is for
repetition that goes nowhere, not for work that takes a while.

When the limit is hit, the run still finishes and still reports. Only the handoff
is withheld, and a comment names the count, the limit, and the agent that would
have run next. Posting `/<agent>` resumes it.

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

Add shell commands to `environment.setup_commands`. They run through `bash -c`, in
order, and stop on first failure — before the agent starts, before `checks.commands`,
and before `deploy.targets`. One declaration, three jobs.

That is the reason to use this field rather than putting `npm ci` at the front of
`checks.commands`, which works and drifts: the agent's shell and CI then install
their dependencies from two places, and a test that passes for the agent and fails
in CI reaches an engineer as a defect that does not reproduce on the machine they
can see.

Nothing here receives a secret. Setup runs before any credential enters the
environment, in all three jobs.

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

### What a pull request is checked against

Every pull request an agent opens is checked for one thing before your CI is asked
to run at all: whether the `.github/atoma/` it would merge can still start a run.

This is not your pipeline and it is not configurable. It runs whether or not
`checks.commands` is set, and it reads nothing from `checks` or `deploy` to decide
what to check — those describe what YOU verify. This one answers a narrower
question that only has one right answer.

What it checks:

- Every `mcp_servers` name in every agent definition exists in `tools.yaml`, along
  with `knows_about` targets, `callable_by` values and `extra_body` keys. This part
  runs `atoma validate`, so it is the same resolution a run performs rather than an
  imitation of it.
- `config.json` uses only keys Atoma reads — see [the contract
  above](#configjson-contract).
- `auto_triggers`, `merge_gates`, `deploy.targets` and the three `secrets` lists
  parse. These were already validated, but at merge time, at deploy time, and when
  a credential was handed out. Nothing new is being judged; it is being judged
  earlier.
- Names resolve to files: an agent an `auto_triggers` entry routes to, an agent
  `agents.<name>` configures, the workflow `workflows.ci` and `workflows.cd` name.

What it does not check is anything that needs a run to find out. Whether your
commands pass, whether a deployment works, whether a model answers — that is CI's
job, and this deliberately does not duplicate it.

**Why this exists.** Atoma resolves every `mcp_servers` name against `tools.yaml`
and aborts before a single tool server starts if one is missing. Nothing objected
at merge time, so the failure landed on whoever triggered the *next* run — which
had already happened once here: an agent looked at its own tool surface, concluded
a server was unused, removed it, and broke a different agent that depended on it.

**What you see when it fails.** The required check goes red, the problems are
listed in a comment on the pull request, and the engineer is dispatched to fix
them — the same handling as failing CI, including the retry limit. The agent sent
to fix it is unaffected by the breakage, because a run reads its machinery from the
default branch rather than from the pull request.

You can run the same check yourself, against a checkout or a worktree:

```bash
bun run .github/scripts/validate_deliverable.ts --root .
```

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

### Conditions of your own that an agent may not merge past

`governed_paths` covers Atoma's own machinery. Your project has its own things
that should not land unread — a database migration, a change to a pricing table, a
release note — and they are not describable as a path alone. "Anything under
`db/migrations/`" is sayable; "only when a migration is **added**" is not.

`merge_gates` is that, and it behaves exactly like the gate above: the agent
reviews the pull request, posts the review, and says it is ready for a person. The
merge is yours.

```json
{
  "merge_gates": [
    {
      "reason": "This adds a database migration. Please check it before merging.",
      "when": { "files_added": ["db/migrations/**"] }
    }
  ]
}
```

`reason` is written to a person and relayed to them verbatim, in whatever language
you write it in. It is the whole output of the gate, so say what you want checked
rather than restating the condition.

**Conditions.** Every one you name must hold, so one gate is one situation.
Several gates are several situations.

| Condition | Matches when |
| --- | --- |
| `files_added` | a file the pattern claims was added (a rename into it counts) |
| `files_removed` | a file the pattern claims was deleted (a rename out of it counts) |
| `files_modified` | an existing file the pattern claims changed |
| `files_changed` | any of the three — what `governed_paths` matches on |
| `labels` | the pull request carries any one of these labels |
| `title_matches` | the title matches this regular expression, case-insensitively |

A pattern is a literal path or a directory followed by `/**` — the same two forms
`governed_paths` accepts, and the only two. Anything else, `**/*.sql` included, is
rejected when the file is read rather than quietly matching nothing.

**Mistakes are errors, not silence.** A misspelled condition, a pattern this
matcher cannot honour, a gate with no conditions at all: each stops the merge and
says why, instead of producing a gate that never fires. A gate that never fires
looks exactly like a gate you did not need, and you would find out from the merge
that went through.

For the same reason a gate that cannot be read blocks rather than disappearing.
Otherwise the way past a gate would be to break it.

**Why not a required status check.** A required check stops everyone, including
you. These stop only the agent, which is the actual request: not "this must not be
merged" but "this is not an agent's call".

**Why configuration and not a script.** A script could read a migration and notice
it drops a production table, which no amount of configuration can. It also needs a
timeout, a decision about what a crash means, and protection against a pull
request supplying the very program that judges it. `config.json` is read from the
default branch already, so a pull request cannot weaken the gate that is judging
it. If you hit a real case that conditions cannot express, that is worth an issue —
the shape here leaves room for it.

### Give a tool a credential

A tool server that talks to something outside GitHub needs one — a Slack token,
an API key for your issue tracker.

**Three steps, and each does a different job.** Doing two of them and wondering
why nothing arrives is the usual way to get this wrong, so they are worth keeping
straight.

**1. Add the secret to the repository**, the usual way, in Settings. Nothing here
creates a secret; the other two steps only refer to one.

**2. Authorise the run to hold it**, in `config.json`:

```json
{
  "tools": { "secrets": ["SLACK_TOKEN"] }
}
```

This says the run may obtain that secret. It does not say which tool gets it — at
this point no tool can see it.

**3. Route it to the tool that needs it**, in `tools.yaml`:

```yaml
slack:
  command: mcp-server-slack
  env:
    SLACK_TOKEN: "${SLACK_TOKEN}"
```

Now that one server receives it, under that name. **Every other tool still
cannot see it**, including the shell.

You never edit a workflow for any of this.

### Why a credential has to be routed

Because a tool server receives only what its own `env:` names. Anything Atoma
recognises as a credential is removed from a server's environment before that
block is applied, so `env: {}` means "this server gets no credentials" — which is
the default, and is the point rather than an oversight.

The shell tool is the one to think about. It can run anything, so a credential it
can read is a credential the agent can read and send anywhere. Leaving it out of
`shell`'s `env:` is what makes "the tool holds the secret, the agent does not"
true rather than aspirational.

Which layer decides what:

| Layer | Decides |
| --- | --- |
| Repository secrets | the value |
| `config.json` `tools.secrets` | whether the run may hold it |
| `tools.yaml` `env: ${NAME}` | which tool receives it |

Never write a value in `tools.yaml`, only a `${NAME}` reference. A pasted secret
is committed in plain text.

### What this does and does not protect

A credential reaches the Atoma process and the servers that name it. Nothing else
— not the shell, not another tool server's declared credentials by ordinary
means, not a later workflow step.

Two limits are worth stating plainly rather than discovering.

**Tool servers are not isolated from each other.** They run as the same user, so
a deliberate attempt from one can reach another's environment. Treat a credential
declared for one tool as reachable by all of them if something is actively trying.

**None of this stops intent, only accident.** An agent reads issue text written by
anyone who can open an issue, and a prompt injection can ask it to do whatever a
tool allows. What remains is the two controls that always mattered: declare only
the credentials a tool genuinely needs, and read the diff when a governed file
changes.

### When it takes effect, and what fails loudly

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

**How much it may print** is a separate limit, and it is not configurable. A long
stdout or stderr keeps its beginning and its **end**, with a marker naming how
much went from the middle and `output_truncated` set on the result. Both ends,
because command output is both kinds of text at once: a header or a command echo
worth seeing, and a failure at the bottom.

That end used to be the part that was dropped — the cap was a million bytes and it
kept the head, so a build log that overran returned its banner rather than its
error. A million bytes is also about 250k tokens, more than a context window, from
one call. See [Adding a tool without flooding the
context](#adding-a-tool-without-flooding-the-context) for why that matters beyond
the one run.

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

### What a tool can and cannot be protected from

Every tool server runs as **one dedicated OS user with no sudo**. One user, so no
tool sees a different filesystem, a different `$HOME` or a different toolchain from
another. No sudo, because with it nothing else means anything: `sudo cat
/proc/<pid>/environ` reads any process whatever else is arranged.

That is a deliberate trade, and knowing which way it went is more useful than a
claim of full isolation.

**Three things cannot all be true.**

1. every tool sees the same environment
2. a credential in one tool is hidden from the shell tool
3. any third-party MCP server works

(3) means a server takes its credential the way it was written to, which is an
environment variable. (1) means the shell shares the filesystem and the user with
it. Given both, (2) fails — and not through one hole that can be closed.
`/proc/<pid>/environ` is readable between processes of one user; a file called
`gh` in a world-writable directory on PATH is executed by the server looking for
`gh`; a config file under `$HOME` tells another tool what to run. Each of those
has an answer below — and the point is that the *list* of channels is not
enumerable, so closing the three that are known is not the same as a guarantee.

**What was chosen:** (1) and (2) for the tools this project ships. (3) as a
documented limit rather than a guarantee.

#### Protected

**The provider API key.** It is never in a tool server at all. Atoma holds it, and
makes itself unreadable to processes of the same user, so no tool can reach it.

**Credentials in the servers this project ships** — `github`, `web`, `search`,
`atoma`. Each makes itself unreadable at startup and removes world-writable
directories from its own PATH, so neither reading its environment nor planting a
binary it would run works.

#### Not protected, deliberately

**`GH_TOKEN`, from the shell tool.** It expires when the job ends, the agent can
already use it through the `github__*` tools, and `actions/checkout` leaves the
same value in `.git/config` inside the work tree — so a boundary around the
server's environment would not have covered it anyway.

**A credential you route to a THIRD-PARTY server** through `tools.secrets`. That
server cannot be made to protect itself — the mechanism has to be called by the
process it protects, and nothing can call it on another program's behalf. Assume a
credential you give a third-party server is readable by the shell tool.

If that matters for a particular credential, the options are to give it only to a
server shipped here, or not to route it at all and let the tool that needs it be a
step in `checks.commands`, which runs in its own job.

#### What this replaced

The shell tool ran in a rootless podman container until v0.1.62. The container hid
the other servers outright, and the cost was that the shell had a different
filesystem: `$HOME` was an overlay, so a write there succeeded and then was not
there for any other tool. Measured across this repository's stored agent sessions,
that boundary was crossed in 18 of 2,118 shell calls — rare, and silent every
time. A write that reports success and does not persist is not something an agent
can reason about, and the container's other costs (a generated `/etc/passwd`,
subordinate id ranges, a masked `/proc`) were paid on every run.

Writes outside the repository now **fail** instead. `$HOME` is read-only, the same
for every tool, and package-manager caches are redirected to a writable directory
by the runner. An error an agent can read beats a success it cannot trust.

### Adding a tool without flooding the context

If you add an MCP server, this is the part that goes wrong quietly.

**A tool result is not a return value.** It joins the agent's session on the
`atoma-data` branch and is **resent on every later inference in that session,
across runs**. One large result is not a one-off cost — it is rent charged for the
rest of that issue's life. And when the session outgrows the model's context
window, the run fails with a provider error that has nothing to do with the tool
that caused it.

This is measured, in this repository. The largest single tool result in its stored
sessions was about **206k tokens** — more than a 200k context window, from one
call. One session reached ~672k tokens, of which the actual conversation was 9k;
the other 663k was tool output.

Five rules, in the order they pay off.

**1. Never return an API response whole. Project it.**

This is worth more than any cap, because a projection loses nothing. Measured on
this repository's own tools, before they were fixed:

| tool | raw | projected | |
| --- | --- | --- | --- |
| `get_branch` | 11,614 B | 81 B | **143×** |
| `get_check_runs` | 24,954 B | 1,363 B | **18×** |
| `get_pr_reviews` | 905 B | ~400 B | 2× |

`get_check_runs` asked GitHub for eight check runs and returned sixteen fields
each, of which the `app` object was **2,244 bytes per run** — the same GitHub App
description, eight times. What an agent can act on is four fields.

There is a pattern in those numbers: the tools built on `gh --json` were already
light, and the ones built on `gh api` were heavy. `--json` makes you name what you
want. Prefer whatever forces that choice.

**2. Cap every output, and say when the cap fired.**

Silence is the worst failure here. A truncated result that looks complete is how
an agent concludes something is absent when it was merely not shown — and then
acts on that. Put the marker **in the text**, not only in a sibling field: the
sibling field is what a caller forgets to read.

**3. Think about which end you keep.**

`shell_execute` kept the first million bytes of its output. A build log that
overran therefore returned its banner and dropped the compiler error — the only
part worth returning. A log is truncated from the front; a listing, a document or
a diff from the back; command output from the middle, keeping both ends.

**4. A count limit is not a volume limit.**

`get_issue_comments` bounds how *many* comments it returns and said nothing about
how big one may be, so a single comment with a log pasted into it filled the
window while the tool reported having shown three of forty. Cap each item *and*
the whole.

**5. Say the shape in the tool's description.**

The description is where a model reads a constraint — measured to work better
than the same sentence in the system prompt. A description promising "a JSON
branch object" while the tool returns three fields sends the model looking for
something that is not there. Say what you return, say that it can be truncated,
and say what to do about it.

Atoma's own tools share one budget, `TOOL_OUTPUT_BUDGET` in
`src/domain/tool-output.ts`: 50,000 characters, about 12.5k tokens, a tenth of the
smallest context window worth designing for. It was four numbers in three units
before — 1,000,000 **bytes** in the shell, 60,000 characters in `web_fetch`, 50,000
in two GitHub tools, and nothing anywhere else.

**What is not covered.** `filesystem*` is a third-party server
(`@modelcontextprotocol/server-filesystem`), and `tools.yaml`'s hooks can allow or
deny a tool but not touch its output — so `read_file` on a large file has no cap
this project can impose. Two of that server's heaviest tools, `directory_tree` and
`search_files`, are on its denylist for that reason. For a large file, have the
agent read a range with `shell_execute` (`sed -n`, `head`) instead.

### How long your tool has to answer

Atoma cuts off one `tools/call` after 60 seconds. If your server can take longer,
say so in its `tools.yaml` entry:

```yaml
my_tool:
  command: bun
  args: ["run", "./scripts/my_tool.ts"]
  request_timeout_secs: 600
```

**A timeout argument in your tool's own schema does not raise this.** That is the
trap, and it is not hypothetical — it is how the shell server shipped. Its
`shell_execute` advertised `timeout_seconds` up to 3600 and defaulted to 300, so
the agent was told it could run a long build. Atoma cut the call off at 60, and
the error read `Timed out calling tool 'shell_execute' on MCP server 'shell'` — which
names your server, not the limit. Every value above 60 was a promise nothing kept.

Two shapes of work need this:

- **work that is genuinely long**: a build, a test suite, a migration.
- **a first call that pays for something the rest do not** — a model, an index, a
  connection. The search server loads a 544MB reranker on demand; it took 63.9
  seconds against the 60-second cap, so the first search of every run failed and
  the answer arrived fifteen seconds after nobody was waiting for it.

For the second shape, prefer moving the cost off the request before raising the
limit. Start the load when the server starts and do not await it — hold the
*promise*, not the resolved value, so the first call joins a load already in
progress instead of beginning one. Between the server connecting and the agent's
first search there were 47 seconds of the agent reading the issue, and that is
where a 63.9-second load mostly fits.

**Do not raise it just in case.** This limit is the only thing that notices a
server which has stopped responding. A server that answers in milliseconds should
keep the default, so a hung one is reported in a minute rather than in however long
seemed generous. `0` means the default, the same as leaving it out.

`ATOMA_MCP_TIMEOUT` changes the default for every server in a run, which is a
debugging lever rather than a configuration: a per-server value is the one that
travels with the tool.

### If your tool does time out

The call fails and the agent sees an error. **Your server is not told** — it keeps
working and eventually writes an answer that nobody is waiting for.

Atoma discards that answer, matching the JSON-RPC `id` to the request in flight,
and logs a `warn` naming both ids. You do not have to do anything for this, but two
things follow for a server you write:

- **echo the `id`.** A server that returns a response without the id it answers,
  or with the wrong one, cannot be read correctly after any timeout.
- **do not assume the client is still there.** Work started before a timeout is
  work whose result is thrown away, so anything with a side effect should be
  idempotent — the agent will call you again.

### Recurring work

You want a check run every week. Atoma has no schedule setting, and will not
grow one — but the thing you want is two steps away, and both are ordinary.

Copy [`examples/workflows/scheduled-issue.yml`](../examples/workflows/scheduled-issue.yml)
into your own `.github/workflows/`, edit the cron, the title, the body and the
agent, and you are done.

**Why it is not a setting.** `on:` accepts no expression, so a cron string cannot
come from `config.json`. That is GitHub's rule, not a choice made here. The
workaround — a fixed daily cron that checks the date inside a script — was
considered for deployments and rejected, and is worse for agents: a deployment
that no-ops costs a few seconds of runner time, while an agent that starts and
finds nothing to do costs a billed inference.

**Why it creates an issue instead of starting an agent.** Agents work on an issue
or a pull request. Something you want done every week *is* a work item that should
exist every week — so the schedule creates the work item, and everything after
that is the machinery you already have: triggers, the in-progress label, session
persistence, review, merge gates. Nothing needs a schedule-only execution path.

It also puts the cost where you can see it. An issue is free. Whether it becomes
an agent run is then an ordinary decision — `auto_triggers`, a label, someone's
comment — rather than something a cron expression decided months ago and nobody
has looked at since.

**The part that will catch you.** An issue created with `GITHUB_TOKEN` raises no
`issues: opened` event. GitHub does not start workflows from events its own token
caused, so the issue appears and nothing picks it up. The example therefore
dispatches `atoma-runner.yml` explicitly, in its last step, and that step is not
optional.

Atoma meets this rule in three other places and answers it the same way: agent
pull requests use `pull_request_target`, and agent merges are followed by an
explicit dispatch from `dispatchCi` / `dispatchCd`.

**You have to copy it yourself.** GitHub refuses `GITHUB_TOKEN` writes to
`.github/workflows/**` by identity, on every path and branch, so no agent can add
this for you — and `.github/**` is a governed path, so a person merges the pull
request that adds it. Both of those are the system working, not obstacles to
route around.

**What it will cost.** One agent run per firing, whether or not there was
anything to do. Multiply your provider's per-run cost by 52 for a weekly
schedule, 12 for a monthly one, and decide with that number in front of you. If
the answer is uncomfortable, the schedule is probably too frequent for the work —
which is the question this arrangement puts in front of you rather than hiding.

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

/**
 * atoma-cli.ts — the steps that put the `atoma` binary on a runner, and the
 * version they install by default.
 *
 * Two workflows need it now. `atoma-runner` runs agents with it; `atoma-validate-pr`
 * calls `atoma validate` on the agent definitions and tools file a pull request
 * would merge, so that a name resolving to nothing is a red check rather than a
 * failure on whoever triggers the next run. Both install it the same way, from one
 * place, because a second copy of a download-and-chmod is a second thing to fix
 * when a release asset is renamed.
 */
import { ActionsCheckoutV4 } from "@github-actions-workflow-ts/actions";
import { TypedOutputsStep } from "./base.ts";

/**
 * The Atoma release a run installs unless the dispatch says otherwise.
 *
 * Every raise of this pin so far has been coupled to something else in this
 * repository, and the record of what is the reason this comment is long.
 *
 * Moves with `tools/tools.yaml`, not independently. From v0.1.11 atoma removes
 * the credentials it knows about from a tool server's environment unless that
 * server names them, and expands `${NAME}` in an `env:` value against the run's
 * credentials. Before v0.1.11 those values were literal, so a tools file carrying
 * `${GH_TOKEN}` would hand `github` those seven characters as its token --
 * overriding the value it had been inheriting and failing every call with a 401.
 *
 * So the two are one change: raising this pin without the declarations strips a
 * token nothing asks for, and shipping the declarations without raising it passes
 * a literal.
 *
 * v0.1.12 adds the same coupling for `args`: it expands `${NAME}` there, from the
 * environment, which is how a tool server is read from the machinery checkout
 * rather than from the pull request under review. To v0.1.11 an `args` entry
 * carrying `${ATOMA_MACHINERY_ROOT:-.}` is a literal path that does not exist, so
 * this pin and `tools/tools.yaml` move together here too.
 *
 * v0.1.13 is a third coupling, and this one is with the repository's SECRETS.
 * Providers became a table there: `openai` means OpenAI rather than defaulting to
 * OpenRouter, the routers have their own names, and each provider reads its own
 * credential -- `OPENROUTER_API_KEY`, `ORCAROUTER_API_KEY` -- with no fallback to
 * `OPENAI_API_KEY`. Two credentials present is an error naming both, so a
 * repository that keeps an OpenRouter key under the old name AND adds it under the
 * new one gets a failed run rather than a guess. Raising this pin means the secret
 * has to have been renamed first.
 *
 * v0.1.14 gives each router a name for each dialect it serves, which is what the
 * agent definitions here needed: they read `provider: openai-responses # openrouter`,
 * a row that in v0.1.13 means OpenAI itself. So this pin moves with
 * `agent-definitions/*.md` as well.
 *
 * v0.1.16 carries two fixes that are about THIS repository's runs specifically.
 *
 * The Responses adapter assembled its own `extra_body` merge and left out the
 * reconciliation that protects the runtime tool definitions -- so an agent carrying
 * `extra_body.tools` replaced them. All three definitions here carry OpenRouter's two
 * server tools, and all three use that adapter, so every request sent those two and no
 * MCP schema at all. The model was inferring argument shapes from the names in the
 * system prompt, which is the shape of the argument failures that have been read as model
 * weakness -- `issue_number` for `number`, `form` for `from`, `label` for `labels`.
 *
 * And a `vision: false` agent had pictures replaced before the message entered the
 * session, so what atoma-data recorded was not what happened: resuming with
 * `vision: true` could never get them back.
 *
 * v0.1.17 is a fourth coupling, this one with `tools/tools.yaml` again, and the
 * first where the OLD version is actively wrong rather than merely unaware.
 *
 * It reads `request_timeout_secs` per server. v0.1.16 ignores the key -- serde
 * drops unknown fields -- so the tools file is accepted either way and nothing
 * fails. What the old version does instead is cap every `tools/call` at 60
 * seconds, which is what `shell` and `search` declare that key to escape:
 *
 *   - `shell_execute` offers the agent `timeout_seconds` up to 3600. Under v0.1.16
 *     every value above 60 is a promise that cannot be kept, and a build or a test
 *     suite running over a minute fails with an error naming the shell server
 *     rather than the client that gave up.
 *   - the first search of a run loads a 544MB reranker. Measured at 63.9s against
 *     the 60s cap, so under v0.1.16 the first search of EVERY run fails.
 *
 * v0.1.17 also matches the JSON-RPC id when reading a response. Without that, one
 * timeout desynchronises that server for the rest of the run: the abandoned call's
 * answer stays in the pipe and the next call reads it, so every answer belongs to
 * the previous question and nothing detects it. Which makes lowering this pin back
 * to v0.1.16 worse than it looks -- the timeouts declared in the tools file stop
 * applying at the same moment the mispairing starts.
 *
 * v0.1.18 is why an agent can see a degraded tool at all. A server that reports a
 * problem about itself -- over `notifications/message`, or on stderr, which is
 * what the servers here use today -- has that report attached to its next tool
 * result. Under v0.1.17 the notification was discarded and the stderr line went to
 * the run log, where a person reads it later if at all. `search.ts` logging
 * "WARN could not preload the reranker" is the case that made this necessary: two
 * releases went out with every search answering worse. The instruction that acts on
 * the report is in `prompt-template.md` and `engineering/environment`, so pinning
 * back to v0.1.17 leaves those two telling an agent to read something it will never
 * be shown.
 */
export const ATOMA_DEFAULT_VERSION = "v0.1.18";

export const ATOMA_VERSION_DESC =
  "Atoma CLI version tag to install (e.g. v0.1.7). Use `source` to build from a checkout of yuma-seno/atoma@main.";

/**
 * Checkout for `atoma_version: source`, which builds the CLI from `main` instead
 * of downloading a release.
 *
 * Only the runner offers that: a workflow installing a fixed version never
 * reaches the `source` branch below, so it needs no checkout.
 */
export const checkoutAtomaSourceStep = new ActionsCheckoutV4({
  name: "Checkout Atoma source (for atoma_version: source)",
  if: "inputs.atoma_version == 'source'",
  with: { repository: "yuma-seno/atoma", path: "atoma-src" },
});

/**
 * Install the CLI at `version`, which is shell text: an input expression for a
 * workflow that takes one, or a literal tag for a workflow that pins it.
 *
 * The `source` branch is generated into both workflows even though only the runner
 * can select it. A literal version simply never matches it, and one script that
 * both workflows share cannot drift; two scripts differing by one branch can.
 */
export function installAtomaCliStep(version: string): TypedOutputsStep {
  return new TypedOutputsStep({
    name: "Install Atoma CLI",
    shell: "bash",
    run: `VERSION="${version}"
if [ "$VERSION" = "source" ]; then
  echo "Building Atoma from source (atoma-src/) ..."
  cargo install --path atoma-src --force --locked
elif [ "$VERSION" = "latest" ]; then
  URL="https://github.com/yuma-seno/atoma/releases/latest/download/atoma-linux-x86_64"
  echo "Downloading Atoma \${VERSION} ..."
  curl -fsSL "$URL" -o /usr/local/bin/atoma
  chmod +x /usr/local/bin/atoma
else
  URL="https://github.com/yuma-seno/atoma/releases/download/\${VERSION}/atoma-linux-x86_64"
  echo "Downloading Atoma \${VERSION} ..."
  curl -fsSL "$URL" -o /usr/local/bin/atoma
  chmod +x /usr/local/bin/atoma
fi
atoma --version
`,
  });
}

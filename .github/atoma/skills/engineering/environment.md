---
name: engineering/environment
description: Decide where a missing dependency or tool belongs, and how to get it without spending the run. Load when something you need is not installed, an install fails, the work tree is broken, or a tool result carries a problem the server reported about itself.
---

# When something you need is not there

Three questions, in this order. Getting the first one right is most of it. Then a
fourth, for when the thing you need is there and answering you badly.

## 1. Is it a library your project declares?

A package your code imports, named in `package.json`, `Cargo.toml`,
`requirements.txt`, `go.mod`, `pyproject.toml`.

**Edit the manifest and install it.** You can write the work tree, and the install
goes there too. This is ordinary work, part of the change, and it gets committed
and reviewed with the rest.

```
bun add zod          # or cargo add / pip install -r / go get
```

If the install command itself fails for lack of permission, it is not a library
question — go to 2.

## 2. Is it a system package, or a globally installed tool?

`apt-get install`, `npm install -g`, anything that writes outside the repository.

**You cannot install it.** You have no `sudo`, `/usr/local` is not writable, and
that is deliberate: an install done during a run does not exist on the next one, so
it would work once and then look like a flake.

It belongs in `environment.setup_commands` in `.github/atoma/config.json`:

```json
{
  "environment": {
    "setup_commands": [
      "sudo apt-get install -y libpq-dev",
      "bun install --frozen-lockfile"
    ]
  }
}
```

**Add it, then say so in your report and stop.** That file is a governed path — a
person merges it — and until they do, the package is not there. Do not reload
hoping it will appear: the setup commands come from the default branch, so a line
you just added to your branch is not in them yet. You would get the same
environment back and spend a run finding out.

## 3. Is the environment broken, or does it need what you just declared?

You added a dependency to a manifest and want it installed by the project's own
command. Or you deleted `node_modules` and want it back. Or an install left
something half-done.

**`atoma_env__reload_environment`.** It re-runs `environment.setup_commands` as a
privileged step against your current work tree, then starts a new run.

The split is what makes it safe and what makes it useful: **the commands come from
the default branch, the data from your work tree.** So your edited manifest gets
installed by a command you did not write and cannot change.

Two things to know before you call it:

- **Your session ends immediately.** Commit what is worth keeping first. Leave
  notes in `/tmp/atoma-workspace`, which survives into the next run.
- **There is a limit**, because each reload starts a new run and resets the
  run's time budget. The tool tells you where you stand. When it refuses, report
  what you found — that is the useful thing left.

## 4. Did a tool report a problem with itself?

A result can end with a block naming the server that produced it:

```
--- 1 problem reported by the 'search' server, not part of the answer above ---
warning: could not preload the reranker (EACCES), results are first-stage ordered
```

**That is not a failure of your work.** It says something about the tool, not
about your call, and the answer above it is what the tool could manage rather than
what it should have given you. The pull is to read a poorer answer as a poorer
question and try again differently -- and that is exactly how a broken environment
stays broken, because the run that could have said so filed an apology instead.

It happened: the reranker above failed to load for a permission change, every
search answered with first-stage ordering, and **two releases went out** before
anyone noticed. Nothing was there to sense. The results looked like results.

So:

1. **Read what it says.** It is one or two lines and it names the thing.
2. **Work out where the cause lives.** The tool's own implementation
   (`.github/atoma/tools/`), the environment that runs it
   (`environment.setup_commands`, permissions on a cache directory), or your use
   of the tool. The three are usually distinguishable from the message.
3. **Open an issue** -- `github__create_issue` with `sub_issue: false`, because a
   defect in the tools is not a child task of the work you were doing. Quote the
   line as it arrived, say which tool call carried it, and say what you concluded
   in 2.
4. **Propose the fix if it is clear**, in the same run or by handing off. Both
   `.github/**` and `scripts/**` are governed paths, so a person decides at the
   merge -- which is why you can go ahead and propose rather than asking first.

Then carry on with what you were doing, and say in your report that the tool
reported a problem and what you did about it. The work is not blocked by this
unless the degraded answer was load-bearing for it -- and if it was, say that
instead of working around it silently.

**One report, not every call.** The same problem is attached once per run, so a
second occurrence you have already filed needs nothing more.

## What not to do

**Do not install things ad hoc and carry on.** It works for the rest of your run
and for nobody afterwards, including CI. The check job runs
`environment.setup_commands` and nothing else, so a passing test in your shell and
a failing one in CI is exactly what that produces — and the failure comes back to
an agent that cannot reproduce it.

**Do not edit the setup commands to work around a failing install.** If
`bun install --frozen-lockfile` fails because the lockfile is stale, the answer is
the lockfile, not `--no-frozen-lockfile`.

**Do not guess whether something is installed.** Ask:

```
command -v pg_config
bun pm ls | grep zod
```

`$HOME` cannot be listed, so look things up by name rather than by browsing.

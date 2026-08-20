# Environment-Driven Development (EDD)

*Development that drives the environment forward.*

## Definition

Environment-driven development treats the environment an agent runs in as a
development target in its own right, alongside the product, and improves it
using what the environment itself recorded about its own runs.

Every run reveals something the environment lacks. That gap is fixed in the
environment rather than worked around inside the run, and the improved
environment carries into every run that follows.

A note on the name. `Environment-Driven` reads, in English, as *driven by the
environment*. This method means the opposite direction: development is what
drives the environment forward. The name points at the subject; this document
supplies the direction.

## Where it comes from

Two existing practices meet here.

**Infrastructure as Code** turned state into a declaration. Rewrite the
declaration and the applied state changes with it. What it does not carry is any
account of its own operation: why the state is what it is, what was tried before,
what failed.

**Harness engineering** builds the scaffolding an agent works inside — tools,
permissions, instructions, checks. That is the act of building it. What happened
afterwards leaves as run logs and is gone.

Put the two together and a property neither one needed on its own becomes
necessary: **the environment has to keep a record of its own operation.** Once
the environment is something an agent changes, changes need material. What was
attempted, what failed, why a decision went the way it did. Held anywhere but the
environment, improvement becomes guesswork.

Environment-driven development is the name for that meeting point.

## What is at the centre

> The information needed to improve the environment stays inside the
> environment; the environment is changed on the basis of that information; and
> the change takes effect on the next run.
>
> **This loop is closed within the environment.**

The property is self-referential: the environment holds the material for its own
improvement.

Whether the loop is closed is what decides whether this method is in effect. The
parts of the loop are not ranked. Wherever information escapes, the loop opens,
and improvement stops accumulating.

## What "environment" covers

When a person did the work, three things shaped the result: their skill, what
they were asked for, and everything else. The first two correspond to the model
and the instruction. **The remainder is the environment.**

For a person, most of that remainder lived inside them. Only tools and
dependencies were ever written down.

- What had been tried, and what had failed, they remembered.
- Which systems they could reach, their own account decided.
- How far to go before checking with someone, they understood.

None of that transfers to an agent. What is not written down does not exist.
An agent's environment therefore covers, on top of tools and dependencies:

- **What earlier runs produced** — without a record, the same failure repeats.
- **What can be reached, and which credentials arrive there** — undeclared, a
  credential is either handed to everything or missing from the one place that
  needs it.
- **How much may be completed without asking** — undeclared, a person decides it
  again on every run.

Those three are absent from the usual definition of a development environment.
They never needed to be there: the person supplied them.

## How the loop opens

Every failure below is the same failure — the loop is not closed. None ranks
above another.

**Information leaves the environment**

- A person fills a gap during the run. What they said is in no record, the
  environment is unchanged, and the next run meets the same gap.
- Run records stay on one machine. Later runs and other people cannot read them.
- Reasons are not kept. The same question is settled twice, or a decision is
  reversed by someone who never saw why it was made.

**Changes do not reach execution**

- The declaration is not an input to execution. Conventions are written down and
  behaviour does not change.
- The machinery is somewhere it cannot be changed, so what may be declared is
  fixed by the machinery rather than by the team.

**Changes are not made**

- Whoever observed the gap cannot propose the fix, so it waits until someone
  else notices.
- The fix is applied to the run instead of the environment. The gap is stepped
  around and nothing is left behind.

**Improvement is lost**

- The environment belongs to an individual and does not survive a handover.
- Changes carry no history. What changed, and why, cannot be recovered.

## What this method does not prescribe

Implementations, products, models, and specific arrangements are out of scope.
Where each part of the environment lives, and how much runs without asking, are
decided per situation.

Nor does it require that agents be able to change everything. Some of the
environment sits outside any declaration — repository settings, secret values,
platform permissions. Those are changed by people. What the method asks is that
they be named as part of the environment, so that the intended state can be read
and a drift from it can be seen.

## Adjacent concepts

| Concept | What it manages | Relation to EDD |
| --- | --- | --- |
| Prompt engineering | The content of one instruction | EDD's subject is what surrounds the instruction |
| Context engineering | What is assembled for one run | Context is built per run and discarded with it. The environment sits outside the run and persists across runs |
| Harness engineering | Building the scaffolding an agent works inside | EDD keeps developing it, from what the environment recorded about its own runs |
| Dev Environment as Code | Tools, dependencies, and runtimes for human development | Narrower scope. EDD also covers records, credential routing, and delegation limits |
| Shared memory layers | An agent's memory, synchronised across people | Covers records alone. Where execution still belongs to individuals, the rest of the loop stays open |
| Environment as Code | A whole production environment — infrastructure, services, configuration, data | A different term for a different subject |

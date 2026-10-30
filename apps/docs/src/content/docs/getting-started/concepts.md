---
title: Core concepts
description: The vocabulary the rest of the docs assume
---

These are the words the rest of the docs use without stopping to explain
them. They're in the order you meet them in the
[Quickstart](/scarn/getting-started/quickstart/).

## Project

A project is a repository linked to Scarn, and the unit that owns your
pipelines, work items, and workers. `scarn init` reads your repository's
`origin` remote and either finds the project that matches it or creates one,
then records it in `.scarn/scarn.jsonc` as `owner/slug` — the owner's
username and the project slug, the same pair as its web URL — so later commands
don't need it. See [`scarn init`](/scarn/reference/cli/#scarn-init).

## Work item

A work item is one thing to do: an issue, a ticket, or a sentence you typed.
Work items are synced from GitHub, Bitbucket or Jira, or created by hand — the
designer creates one for you when you describe the work instead of picking an
existing item. **Every pipeline run is a run on one work item**, and every
design session is built around one. See
[Connect GitHub, Bitbucket or Jira](/scarn/how-to/integrations/).

## Pipeline

A pipeline is a graph of nodes; each node runs a step, waits for a human, or
ends the run with `succeed` or `fail`, and its transitions name what runs
next. Pipelines are TypeScript files in `.scarn/pipeline-builder/`, written
with `definePipeline()` and built into a JSON document that Scarn stores and
runs. See [Building Pipelines](/scarn/guides/pipelines/).

## Default pipeline

The default pipeline is the one every new pipeline-builder directory starts
with, and the one the designer adapts: `bug-pipeline.ts`. It scores whether a
bug report holds enough to act on, with a deliberately low bar, and asks the
reporter for what's missing only when there is nothing to start from.
Otherwise it investigates and reproduces the bug with every tool you give it,
and reports a reproduction confidence. Only a confident reproduction goes on to
a failing test. It then proposes a fix and waits at a decision node until you
approve it, and only then applies the fix. The designer adapts the investigate
step to what your environment can reach. Each step passes its whole output to
the next. It is an opinionated starting point: change any of it.

## Step

A step is the unit of work: an agent prompt and a typed result. The agent reads the prompt, does the work, and returns a result
that must match the step's schema. Each step runs on the host or inside your
devcontainer — see [Runtime](#runtime) below. See
[Defining Steps](/scarn/guides/steps/).

## Evidence and artifacts

Evidence is what a step leaves behind so you can check its work. Some of it is
in the step's result, such as the default pipeline's investigation report.
The rest is files, uploaded as the step's artifacts when it finishes. The
agent saves them with the `scarn-submit-artifact` tool, or writes them to
`${scarn.artifactsDir}`. A step can also declare a file as a result field,
such as a screen recording, so a pipeline can check it exists and a work item
comment can show it. In the dashboard, a step's _Output_ shows its result and
_Artifacts_ lists its files. A Playwright trace gets a **View trace** button
that opens it in Playwright's trace viewer. See
[Attaching artifacts to comments](/scarn/guides/steps/#attaching-artifacts-to-comments).

## Transition

A transition is what happens after a node finishes. Usually that's the next
node in its chain. A condition reads fields of earlier steps' results to
branch, and a `decision` node waits for a human to pick an action, such as
approve or reject, before the run moves on. The default pipeline branches on its quality check and its
reproduction confidence, and waits for a decision before the fix. See
[Transitions](/scarn/guides/pipelines/#transitions).

## Default pipeline assignment

Default pipeline assignment is the set of rules that picks a pipeline for each
arriving work item. It lives in
`.scarn/pipeline-builder/default-pipeline-assignment.ts`, and the designer
writes one wired to the pipeline it builds. If no rule matches and the default
is `skip()`, nothing starts. See
[Default Pipeline Assignment](/scarn/guides/pipeline-assignment/).

## Worker

A worker is `scarn work`: a process on your machine that claims tasks, runs
the agent, and reports its result and artifacts back. A task is one attempt at one step for one
work item. Nothing runs until a worker is up, and you
can run as many as you like, on a laptop or a CI box. See
[Running Workers](/scarn/guides/workers/).

## Runtime

A step's runtime decides where its agent runs. `Runtime.devcontainer()` is the
default: the worker clones your repository and runs the agent inside the
container your `.devcontainer/devcontainer.json` describes, which needs
Docker. `Runtime.host()` runs the agent on the worker's machine in an empty
scratch directory, with no clone and no Docker — the designer uses it for
steps that don't need your code, such as classification, scoring, and triage.

**A devcontainer is optional to start, and the designer writes one.** If your
repository has none, the design session authors
`.devcontainer/devcontainer.json` before it writes any pipeline file, from
what it read of your repository: version pins, the lockfile's package manager,
`docker-compose.yml` services, and CI install steps. It does not build the
image, so your first run is what verifies it — if that run fails early,
suspect the container before the pipeline. `scarn init` only reports a
missing devcontainer. A pipeline made only of host steps never needs one. See
[Runtime](/scarn/guides/steps/#runtime), or
[Set up a dev container](/scarn/how-to/devcontainer/) to write one by
hand.

## The designer

The designer is `scarn pipelines design`: an agent session that interviews
you about one work item and adapts the [default pipeline](#default-pipeline)
to it. Before it starts, it lists the MCP servers and skills it finds in your
repository, so it can offer those tools to your steps. It runs on a
Scarn-managed OpenCode runtime, using an AI provider you connect once —
the same connection your steps use later. When the files typecheck, it pushes
them and offers to run the pipeline on that work item. See
[`scarn pipelines design`](/scarn/reference/cli/#scarn-pipelines-design-project).

## The studio

The studio is a browser tab the designer opens: a live graph of the files it
is writing, with validation issues. It is read-only and redraws every time a
file changes. You can also open it on its own. See
[`scarn pipelines studio`](/scarn/reference/cli/#scarn-pipelines-studio).

## Dashboard

The dashboard, at [app.scarn.io](https://app.scarn.io), is where runs,
logs, and traces live. It's also where you can start a run by hand from a
work item's executions drawer, and where you connect GitHub, Bitbucket or Jira under
**Project → Settings → Integrations**.

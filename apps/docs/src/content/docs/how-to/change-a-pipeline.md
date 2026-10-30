---
title: Change the pipeline you built
description: Re-run the designer on another work item to tweak a pipeline, route items to it, or add a new one
---

```bash
scarn pipelines design --work-item-id <id>
```

Run the designer again, from anywhere in your repository, on a work item the
current pipeline handles badly — or leave off `--work-item-id` and pick one
(see [Choosing a work item](/scarn/reference/cli/#choosing-a-work-item)).
It's the same command you used on day one. It doesn't start over; it edits
what's there.

## What the designer reads first

Before it asks you anything, the designer reads every definition in
`.scarn/pipeline-builder/`, summarizes each pipeline in a line, and notes
where they already overlap the item you picked. If the last session's
[post-push dry run](/scarn/reference/cli/#dry-runs) failed, it raises that
first and fixes it before anything else.

It only reads the local files. If a teammate pushed definitions that aren't in
your checkout, pull them first with
[`scarn pipelines pull`](/scarn/reference/cli/#scarn-pipelines-pull-project).

## Agree on the size of the change

Before it touches a file, the designer states one verdict and waits for your
yes:

| Verdict          | What changes                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| **tweak**        | An existing pipeline: its prompts, its servers, an added step                                     |
| **route**        | `default-pipeline-assignment.ts`, or a `route(...)` outcome, so items like this one reach an existing pipeline |
| **new pipeline** | A new file, for a class of work item that needs a genuinely different shape                      |

It prefers them in that order, and a pipeline that would duplicate most of an
existing one's steps counts as a tweak or a route. If you disagree, say so — it
takes your verdict over its own. Details:
[Edit sessions](/scarn/reference/cli/#edit-sessions).

## Watch it change

The [studio](/scarn/reference/cli/#the-studio) opens again and redraws the
graph each time the designer saves a file, with the same validation issues
`scarn pipelines build` would report. When the definitions typecheck, the
designer pushes the steps (`push` always asks first), then builds and
publishes the pipeline.

## Fix a run that failed

The edit loop is the repair loop. When a step fails or the devcontainer won't
build, run `scarn pipelines design` again and tell the designer what
happened — paste the error or point it at the run in the dashboard. See
[The run offer](/scarn/reference/cli/#the-run-offer).

## Edit by hand instead

The files are plain TypeScript. Edit them in your editor, run
`npm run typecheck` (or your package manager's equivalent) inside
`.scarn/pipeline-builder/`, then push the steps, build, and publish each
changed pipeline ([details](/scarn/guides/pipelines/#writing-and-publishing)):

```bash
scarn pipelines push
scarn pipelines build
scarn pipelines publish .scarn/pipeline-builder/bug-pipeline.json
```

For what you can write, see [Defining Steps](/scarn/guides/steps/),
[Building Pipelines](/scarn/guides/pipelines/), and
[Default Pipeline Assignment](/scarn/guides/pipeline-assignment/). Then
[commit your changes](/scarn/how-to/commit-your-pipeline/).

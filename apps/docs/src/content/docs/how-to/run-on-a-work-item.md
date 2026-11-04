---
title: Run a pipeline on any work item
description: Queue a run on a work item from the dashboard or the designer's run offer, then let a worker execute it
---

```bash
scarn work --work-item-id <id>
```

Running a pipeline takes two things: a **queued run** on the
[work item](/scarn/getting-started/concepts/#work-item), and a
[worker](/scarn/getting-started/concepts/#worker) to execute it. The command
above is the second half — it only claims steps already queued for that item.
With nothing queued, it just polls. Queue the run first.

## Queue it from the dashboard

1. Open your project in the
   [dashboard](/scarn/getting-started/concepts/#dashboard) and go to the
   *Work Items* tab.
2. Open the work item and select the *Pipeline executions* button at the top
   right. A drawer lists the item's runs so far.
3. Select **New**, pick the pipeline, and select **Create**.

**New** is disabled until the project has a pushed pipeline. Once the run is
queued, start a worker with the command above, or plain `scarn work` to
take any queued work in the project.

## Queue it from the CLI

There is no standalone command that queues a run. The closest is the run
offer at the end of a design session: run

```bash
scarn pipelines design --work-item-id <id>
```

and when the session exits cleanly, it asks whether to run the pipeline the
default automation routes to on that item. Say yes and it queues the run and starts the worker in
the same terminal. Say no and it prints the `scarn work … --work-item-id`
command; nothing is queued, so queue the run from the dashboard before you use
it. See [The run offer](/scarn/reference/cli/#the-run-offer) for every case
where no offer appears.

## The worker

`scarn work` keeps polling until you press Ctrl+C, because later steps
queue as earlier ones advance; `--once` polls once, finishes whatever it claimed, and exits.
`--work-item-id` scopes it to one item. Every flag:
[`scarn work`](/scarn/reference/cli/#scarn-work-project). To run
several workers, see [Running Workers](/scarn/guides/workers/).

## Why a new item doesn't start by itself

The [default automation](/scarn/getting-started/concepts/#default-automation)
starts a pipeline when a work item becomes ready: it arrives, its last blocker
closes, or it reopens. It is published disabled, so nothing starts until you
run `scarn automations enable default`. Items that were already ready before
then, including the one you designed the pipeline around, don't fire again;
queue a run for them as above.

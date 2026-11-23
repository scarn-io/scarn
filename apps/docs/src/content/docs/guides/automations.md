---
title: Project Automations
description: Start the right pipeline when a work item is ready, with the default.ts project automation
---

A project automation reacts to events across a project and starts pipelines, or attaches work-item automations, in response. The one every project starts with is `default`, in `.scarn/pipeline-builder/default.ts`: it picks which pipeline runs when a work item becomes ready.

## `default.ts`

`scarn pipelines design` writes one wired to the pipeline it builds; `scarn pipelines init` scaffolds one that sends every ready item to the default bug pipeline (see [which to use](/scarn/reference/cli/#scarn-pipelines-init)).

```typescript
import { contains, equal } from "@scarn/sdk/pipelines";
import { defineAutomation, onEvent, skip } from "@scarn/sdk/automations";
import bugTriage from "./bug-triage";
import regressionReview from "./regression-review";

export default defineAutomation({
  key: "default",
  title: "Default",
  scope: "project",
  rules: [
    onEvent({
      key: "route-ready",
      event: "workItem.ready",
      routes: [
        {
          when: (r) => equal(r.workItem.fields.status, "manual support"),
          to: skip,
        },
        {
          when: (r) => contains(r.workItem.labels, "regression"),
          to: regressionReview,
        },
      ],
      otherwise: bugTriage,
    }),
  ],
});
```

Import each pipeline from its own file and route to the value its `definePipeline()` returns. `scarn pipelines build` compiles `default.ts` to `default.json`, like a pipeline.

## Events

| Event                  | Fires when                                                                                                      | `r` holds               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `workItem.ready`       | An item is open, top level and has nothing open blocking it: it arrives, its last blocker closes, or it reopens | `r.workItem`            |
| `workItem.created`     | An item is first seen, ready or not                                                                             | `r.workItem`            |
| `workItem.label.added` | A label is added to an item                                                                                     | `r.workItem`, `r.label` |
| `schedule`             | The rule's cron comes due (see [Schedules](#schedules))                                                         | `r.schedule`            |

Closed items are never ready, so a `workItem.ready` rule needs no route to skip them. An item that is already in the project when you publish does not fire `workItem.ready` again; queue a run for it explicitly (see [Run on a work item](/scarn/how-to/run-on-a-work-item/)).

## Rules and routes

Every rule has a `key`, unique within its automation: letters, digits, `_` and `-`, not starting with `_` or `-`.

`onEvent({ key, event, to })` always starts `to`. `onEvent({ key, event, routes, otherwise })` checks `routes` top to bottom: the first whose `when` matches wins, and `otherwise` applies when none does. With `match: "all"`, every matching route runs.

| Target      | Does                                              |
| ----------- | ------------------------------------------------- |
| a pipeline  | Starts the published pipeline on `r.workItem`     |
| `attach(x)` | Attaches the work-item automation `x` to the item |
| `skip`      | Does nothing                                      |

`when` uses the same conditions as pipeline [transitions](/scarn/guides/pipelines/#transitions) (`equal`, `contains`, `exists`, …) on `r.workItem.title`, `description`, `labels`, `state` and `fields.<name>`.

## Schedules

A `schedule` rule in a project automation starts a step on a cron. The usual job is polling an external system: the step creates a work item for each new item it finds, and your `workItem.created` and `workItem.ready` rules take it from there.

```typescript
import { defineAutomation, onEvent } from "@scarn/sdk/automations";
import { pollAcme } from "./steps";

export default defineAutomation({
  key: "acme-intake",
  title: "Acme intake",
  scope: "project",
  rules: [
    onEvent({
      key: "poll-acme",
      event: "schedule",
      cron: "*/15 * * * *",
      timezone: "Europe/Stockholm",
      to: (r) =>
        pollAcme({
          since: r.schedule.previousScheduledFor,
          until: r.schedule.scheduledFor,
        }),
    }),
  ],
});
```

| Option        | Default                  | Description                                                                                                                                                                                                                                                       |
| ------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cron`        | required                 | 5 fields (minute, hour, day of month, month, day of week), with `*`, `,`, `-`, `/` and month or day names (`JAN`, `MON`), or one of `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`, `@annually`. No seconds field and no `?`, `L`, `W` or `#` |
| `timezone`    | `"UTC"`                  | IANA name the cron is read in. A time in a skipped daylight-saving hour fires at the next valid time; one in a repeated hour fires once                                                                                                                           |
| `concurrency` | `{ max: 1, waiting: 0 }` | How many runs of this schedule may be open at once: `max` running and `waiting` more queued behind them                                                                                                                                                           |

`defineAutomation` and publishing both check the cron and timezone. The rule's `key` names the schedule: the summary, `scarn automations run` and the run history all use it.

A schedule rule is about no work item, so it can only target a step, without `.on(...)`, or `skip`. A pipeline or `attach(...)` needs a work item; start a step that creates one instead. The step may only have `project` grants (see [Creating work items](#creating-work-items)); publishing rejects a step with grants on `self` or `children`. With `match: "all"`, at most one route may match per run.

A project's enabled automations can have at most 20 schedules together. Publishing or enabling an automation that would go over fails.

### What `r.schedule` holds

| Ref                               | Value                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `r.schedule.key`                  | The rule key                                                                                                               |
| `r.schedule.scheduledFor`         | The cron time this run is for, as an ISO date-time. Not the moment the run started; for Run now, the moment you pressed it |
| `r.schedule.previousScheduledFor` | `scheduledFor` of the schedule's most recent **succeeded** run, or `null` before the first one                             |
| `r.schedule.timezone`             | The timezone the cron is read in                                                                                           |

Use them in `when` and in the step's args, as in the example above. `previousScheduledFor` only moves forward when a run succeeds, so a failed or skipped run widens the next run's window rather than losing items. When it is `null`, the step decides how far back to look.

### How a schedule fires

Scarn checks schedules once a minute. A schedule whose time has come starts its step as a **scheduled Task**: a Task with no work item, owned by the schedule. It has no activity lines, no blockers and no summary comment, and a worker picks it up like any other Task.

- **Missed times collapse.** If several cron times passed since the last check, the schedule runs once, for the latest one. Nothing is backfilled.
- **A full schedule is skipped.** With the default concurrency, a run that comes due while the previous one is still open starts nothing and is recorded as a skip, not an error. A step's own `concurrency` doesn't apply when a schedule starts it.
- **Errors wait for the next cron time.** If the run can't start, for example because the step no longer exists or its args don't fit, the error is recorded on the schedule and it tries again at its next cron time, not every minute.
- **Enabling and publishing don't fire.** The first run is at the next cron time after you enable or publish. Disabling an automation stops new runs; open Tasks keep running until they end or you cancel them.

Publishing keeps a schedule by its rule key. Changing its cron or timezone recomputes the next run. Removing the rule removes the schedule; its Tasks stay in the history. Adding the same key back later starts a new schedule, whose first `previousScheduledFor` is `null`.

### Run now

Run a schedule once, immediately, to test it: select **Run now** next to the schedule on the _Pipelines & Automations_ tab, or run:

```bash
scarn automations run acme-intake poll-acme
```

It goes through the same concurrency check as a scheduled run, with `scheduledFor` set to now, and needs `executions:write`. It works while the automation is disabled and doesn't move the next run. If a run of the schedule is still open, nothing starts and it isn't counted as a skip. A Run now that succeeds moves `previousScheduledFor` forward like any other run.

The usual order is: push, Run now until the step does what you want, then `scarn automations enable`.

### Creating work items

`Features.workItems.create({ scope: "project", labels })` lets a scheduled Task create top-level work items in its project:

```typescript
import { defineStep, Features, Runtime, z } from "@scarn/sdk/definitions/steps";

export const pollAcme = defineStep({
  key: "poll-acme-api",
  name: "Poll Acme",
  status: "active",
  environment: { runtime: Runtime.host() },
  agentPrompt:
    "List Acme tickets updated in the window you were given and create a work item for each.",
  input: z.object({ since: z.string().nullable(), until: z.string() }),
  result: z.object({ found: z.number() }),
  features: [Features.workItems.create({ scope: "project", labels: ["acme"] })],
});
```

The agent gives each item a `platformKey`, a stable id from the system it came from. A key the project already has returns the existing item unchanged, and `workItem.created` doesn't fire again, so the step can send every item it sees without checking for duplicates. New items fire `workItem.created` (and `workItem.ready`) as usual. They live on platform `custom` and can't be edited or relabelled in Scarn. A Task creates at most 100 work items this way.

### Following a schedule

On the _Pipelines & Automations_ tab, each schedule shows its cron and timezone, the next run, when it last fired, its last Task's status, the number of failures in a row (cancelled Tasks don't count or break the streak), its last skip and its last error. While the automation is disabled there is no next run. **History** opens the schedule's Tasks on the _Runs_ tab, whose **Scheduled** filter lists the runs of every schedule.

From a terminal, [`scarn automations list`](/scarn/reference/cli/#scarn-automations-list) prints the same summary.

## Push and enable

`scarn pipelines push` publishes every built automation document after the pipelines. A new automation starts **disabled**, so nothing runs until you turn it on:

```bash
scarn automations enable default
```

Turn it off again with `scarn automations disable default`. See [`scarn automations`](/scarn/reference/cli/#scarn-automations).

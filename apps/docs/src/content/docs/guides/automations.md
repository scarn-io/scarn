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

A `schedule` rule in a project automation starts a step on a cron. The usual job is polling an external system: the step imports each new or changed item it finds as a work item (see [Importing work items](#importing-work-items)), and your `workItem.created` and `workItem.ready` rules take it from there.

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

A schedule rule is about no work item, so it can only target a step, without `.on(...)`, or `skip`. A pipeline or `attach(...)` needs a work item; start a step that creates one instead. The step may only have `project` grants (see [Importing work items](#importing-work-items)); publishing rejects a step with grants on `self` or `children`. With `match: "all"`, at most one route may match per run.

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

### Importing work items

An import is a [code step](/scarn/guides/steps/#code-steps) that reads an external source and writes what it finds through [`context.workItems`](/scarn/guides/steps/#writing-work-items-from-a-code-step). It needs these grants on `project`:

| Feature                                                                | Allows                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `Features.workItems.read({ scope: "project" })`                        | `latestSourceUpdate`, the import's cursor                                     |
| `Features.workItems.create({ scope: "project", labels, keyPrefix? })`  | `upsert` of a key the project doesn't have yet, and `create`                  |
| `Features.workItems.update({ scope: "project", keyPrefix?, labels? })` | `upsert` of a key the project already has, including closing and reopening it |

`keyPrefix` limits a grant to keys that start with it, so a mistake in your mapper can't touch another source's items. `labels` limits the labels a write may set.

```typescript
import { codeStep, Features, z } from "@scarn/sdk/definitions/steps";
import { listAcmeTickets } from "./acme"; // your client for the source

const ACME = { platform: "custom", keyPrefix: "acme:" } as const;
const grant = {
  scope: "project",
  keyPrefix: "acme:",
  labels: ["acme"],
} as const;

export const importAcme = codeStep({
  key: "import-acme",
  name: "Import Acme tickets",
  status: "active",
  features: [
    Features.workItems.read({ scope: "project" }),
    Features.workItems.create(grant),
    Features.workItems.update(grant),
  ],
  resultSchema: z.object({ upserted: z.number() }),
  fn: async (_input, { workItems }) => {
    const latest = await workItems.latestSourceUpdate(ACME);
    const since = latest ? new Date(Date.parse(latest) - 5 * 60_000) : null;
    let upserted = 0;
    // Oldest-updated first, one page (≤ 100 tickets) at a time.
    for await (const page of listAcmeTickets({ updatedSince: since })) {
      const saved = await workItems.upsert(
        page.map((ticket) => ({
          platform: ACME.platform,
          platformKey: `${ACME.keyPrefix}${ticket.id}`,
          title: ticket.title,
          description: ticket.body,
          state: ticket.closed ? ("closed" as const) : ("open" as const),
          sourceUpdatedAt: ticket.updatedAt,
          labels: ["acme"],
        })),
      );
      upserted += saved.length;
    }
    return { upserted };
  },
});
```

- **`upsert` writes by `(platform, platformKey)`.** A new key is created and fires `workItem.created` (and `workItem.ready`) once; an existing key is updated. An item overwrites the stored one only when its `sourceUpdatedAt` is newer, so re-reading the same tickets is harmless.
- **`latestSourceUpdate({ platform, keyPrefix })` is the cursor.** It returns the newest `sourceUpdatedAt` among the project's items under that prefix, or `null` before the first import. Scarn stores no other state for the import.
- **Read the source in ascending order.** Ask the source for items oldest-updated first and `upsert` page by page. Every saved page is then older than every unsaved one, so if a run fails halfway, the next run resumes from the cursor without skipping anything. Subtract a few minutes of overlap from the cursor to cover equal timestamps and sources that filter by the minute.
- **Platforms.** `platform` is `custom`, `jira` or `github`. Jira and GitHub items keep their platform, so comments and links work as for synced items.

Jira and GitHub have ready-made import steps; see [Import Jira or GitHub issues on a schedule](/scarn/how-to/integrations/#import-on-a-schedule). For a step-by-step version of the example above, see [Import from any tracker](/scarn/how-to/import-from-any-tracker/).

:::note[A worker can do only what its user can]
A scheduled Task runs as the user whose worker claimed it, and every `context.workItems` call is checked against that user's project role as well as the step's grants: `work-items:write` for `upsert` and `create`, `work-items:read` for `latestSourceUpdate`. Grants only narrow what the user may do; they never add to it. If the user lacks the permission, or loses it, the next call fails with `WorkItemsRefusedError` and the schedule shows the error.
:::

An agent step can create items too, with `Features.workItems.create({ scope: "project", labels })` and the `scarn-create-work-item` tool. Its items live on platform `custom`, a key the project already has returns that item unchanged, and a Task creates at most 100 this way. `update` on `project` is for code steps only.

### Following a schedule

On the _Pipelines & Automations_ tab, each schedule shows its cron and timezone, the next run, when it last fired, its last Task's status, the number of failures in a row (cancelled Tasks don't count or break the streak), its last skip and its last error. While the automation is disabled there is no next run. **History** opens the schedule's Tasks on the _Runs_ tab, whose **Scheduled** filter lists the runs of every schedule.

From a terminal, [`scarn automations list`](/scarn/reference/cli/#scarn-automations-list) prints the same summary.

## Push and enable

`scarn pipelines push` publishes every built automation document after the pipelines. A new automation starts **disabled**, so nothing runs until you turn it on:

```bash
scarn automations enable default
```

Turn it off again with `scarn automations disable default`. See [`scarn automations`](/scarn/reference/cli/#scarn-automations).

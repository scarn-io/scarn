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
      event: "workItem.ready",
      routes: [
        { when: (r) => equal(r.workItem.fields.status, "manual support"), to: skip },
        { when: (r) => contains(r.workItem.labels, "regression"), to: regressionReview },
      ],
      otherwise: bugTriage,
    }),
  ],
});
```

Import each pipeline from its own file and route to the value its `definePipeline()` returns. `scarn pipelines build` compiles `default.ts` to `default.json`, like a pipeline.

## Events

| Event                  | Fires when                                                                                | `r` holds                 |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| `workItem.ready`       | An item is open, top level and has nothing open blocking it: it arrives, its last blocker closes, or it reopens | `r.workItem`              |
| `workItem.created`     | An item is first seen, ready or not                                                       | `r.workItem`              |
| `workItem.label.added` | A label is added to an item                                                               | `r.workItem`, `r.label`   |

Closed items are never ready, so a `workItem.ready` rule needs no route to skip them. An item that is already in the project when you publish does not fire `workItem.ready` again; queue a run for it explicitly (see [Run on a work item](/scarn/how-to/run-on-a-work-item/)).

## Rules and routes

`onEvent({ event, to })` always starts `to`. `onEvent({ event, routes, otherwise })` checks `routes` top to bottom: the first whose `when` matches wins, and `otherwise` applies when none does. With `match: "all"`, every matching route runs.

| Target            | Does                                                          |
| ----------------- | ------------------------------------------------------------- |
| a pipeline        | Starts the published pipeline on `r.workItem`                 |
| `attach(x)`       | Attaches the work-item automation `x` to the item             |
| `skip`            | Does nothing                                                  |

`when` uses the same conditions as pipeline [transitions](/scarn/guides/pipelines/#transitions) (`equal`, `contains`, `exists`, …) on `r.workItem.title`, `description`, `labels`, `state` and `fields.<name>`.

## Push and enable

`scarn pipelines push` publishes every built automation document after the pipelines. A new automation starts **disabled**, so nothing runs until you turn it on:

```bash
scarn automations enable default
```

Turn it off again with `scarn automations disable default`. See [`scarn automations`](/scarn/reference/cli/#scarn-automations).

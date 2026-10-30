---
title: Default Pipeline Assignment
description: Route incoming work items to the right pipeline automatically with default-pipeline-assignment.ts
---

The default pipeline assignment controls which pipeline is automatically started when a new work item arrives in a project. It lives in a reserved file — `.scarn/pipeline-builder/default-pipeline-assignment.ts` — that is managed separately from regular pipeline definitions.

## File location and authoring

`scarn pipelines design` writes one wired to the pipeline it builds; `scarn pipelines init` scaffolds an example for hand-authoring (see [which to use](/scarn/reference/cli/#scarn-pipelines-init)). `scarn pipelines pull` writes or removes the file based on the server configuration. `scarn pipelines push` syncs it back to the server when it is present, after publishing the built pipelines it assigns.

```typescript
import { defaultPipelineAssignment } from "@scarn/sdk/definitions/pipelines";

export default defaultPipelineAssignment(({ workItem, any, assign, skip }) => ({
  default: assign("bug-triage"),
  rules: [
    any(
      workItem.field("status").eq("resolved"),
      workItem.field("status").eq("manual support"),
    ).then(skip()),
    workItem.title.contains("[urgent]").then(assign("bug-triage")),
    workItem.field("issueType").eq("bug").then(assign("bug-triage")),
    workItem.field("labels").contains("regression").then(assign("regression-review")),
  ],
}));
```

The callback receives a context object; everything needed is destructured from it. Only `defaultPipelineAssignment` needs to be imported from the SDK.

## `default`

The outcome when no rule matches. Use `assign(key)` to start the published pipeline with that key, or `skip()` to do nothing.

```typescript
default: assign("bug-triage")   // always start bug-triage when no rule matches
default: skip()                 // do nothing when no rule matches
```

## `rules`

An ordered list of rules evaluated against each incoming work item. The first matching rule wins; unmatched items fall through to `default`.

Each rule is a condition chained with `.then(outcome)`:

```typescript
workItem.field("issueType").eq("bug").then(assign("bug-triage"))
workItem.field("labels").contains("regression").then(assign("regression-review"))
workItem.field("status").eq("resolved").then(skip())
```

## Work item properties

`workItem` also exposes every top-level work-item property directly, in addition to `workItem.field(name)` for the platform-specific `fields` bag. Each property returns the same kind of comparator ref as `workItem.field(name)`:

```typescript
workItem.platform.eq("github").then(assign("github-triage"))
workItem.title.contains("[urgent]").then(assign("urgent-triage"))
```

| Property | Type |
|----------|------|
| `id` | `string` |
| `projectId` | `string` |
| `platform` | the platform literal union (e.g. `"github"`, `"jira"`) |
| `platformId` | `string \| null` |
| `platformKey` | `string` |
| `url` | `string \| null` |
| `title` | `string` |
| `description` | `string \| null` |
| `sourceCreatedAt` | `string \| null` |
| `sourceUpdatedAt` | `string \| null` |
| `createdByUserId` | `string \| null` |
| `parentWorkItemId` | `string \| null` |
| `createdAt` | `string \| null` |
| `updatedAt` | `string \| null` |

:::note
The date-like fields (`sourceCreatedAt`, `sourceUpdatedAt`, `createdAt`, `updatedAt`) are ISO date **strings** (or `null`), not `Date` objects — compare them with string values, not `.gt(someDate)`.
:::

## Context helpers

| Helper | Description |
|--------|-------------|
| `workItem.<property>` | Access a top-level work item property (`title`, `platform`, `url`, etc. — see [Work item properties](#work-item-properties)). Returns a comparator ref. |
| `workItem.field(name)` | Access a work item field by name. Returns a comparator ref. |
| `context.isNew` | `true` when the work item is being created for the first time. Returns a comparator ref. |
| `assign(key)` | Outcome: start the published pipeline with that key. Also accepts the value a pipeline file's `definePipeline()` returns. |
| `skip()` | Outcome: do not assign any pipeline. |
| `all(...refs)` | All nested conditions must match. |
| `any(...refs)` | Any nested condition must match. |

## Comparators

Comparators:

`.eq(v)` · `.ne(v)` · `.gt(n)` · `.gte(n)` · `.lt(n)` · `.lte(n)` · `.in(values)` · `.notIn(values)` · `.contains(v)` · `.doesNotContain(v)`

Not every comparator applies to every field — `.gt`/`.gte`/`.lt`/`.lte` only exist on numeric fields, so e.g. `workItem.title.gt(...)` is a compile error rather than just bad practice.

## Grouping

```typescript
rules: [
  all(
    workItem.field("issueType").eq("bug"),
    workItem.field("priority").eq("high"),
  ).then(assign("bug-triage")),
  any(
    workItem.field("status").eq("resolved"),
    workItem.field("status").eq("closed"),
  ).then(skip()),
]
```

## Push and pull behaviour

- **push** — if `default-pipeline-assignment.ts` is present, its policy is synced to the server after the steps. Every pipeline it assigns must already be [published](/scarn/guides/pipelines/#writing-and-publishing). If the file is absent, the server configuration is left unchanged.
- **pull** — if the project has an assignment configured, `default-pipeline-assignment.ts` is written. If no assignment is configured, any existing file is removed.
- Pull fails with a clear error if the server contains rules that were not authored with the SDK fluent API and therefore cannot be reconstructed.

## Typed field names with `WorkItemFieldName`

`workItem.field(name)` is untyped by default — `fields` keys are platform- and project-dependent (Jira custom field labels, GitHub keys, etc.), so there's no static schema to check `name` against.

`scarn pipelines pull` also writes `work-item-fields.ts`: a `WorkItemFieldName` union of field names observed for this project as of the last pull. Pass it as `field`'s type parameter to get compile-time validation and autocomplete on a known field name, while `workItem.field(name)` (no type argument) keeps working exactly as before:

```typescript
import type { WorkItemFieldName } from "./work-item-fields";

workItem.field<WorkItemFieldName>("issueType").eq("bug")
```

`WorkItemFieldName` is a best-effort snapshot, not an authoritative schema — new custom fields can appear on the platform side at any time, so `workItem.field(name)` (untyped) remains the safe default for fields you expect to see for the first time.

`field` also accepts a second, optional type parameter that types the comparator value for a known-shaped custom field, independent of the name-typing above:

```typescript
workItem.field<WorkItemFieldName, number>("storyPoints").gte(3)
```

The two type parameters are independent and optional — supply just the first, just the second (`field<string, number>(...)`), both, or neither.

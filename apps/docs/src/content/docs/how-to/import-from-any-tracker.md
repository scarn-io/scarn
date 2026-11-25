---
title: Import from any tracker
description: Write a scheduled code step that imports another system's tickets as work items
---

Scarn ships import steps for [Jira and GitHub](/scarn/how-to/integrations/#import-on-a-schedule).
For any other tracker, write your own: a [code step](/scarn/guides/steps/#code-steps)
that reads the source and writes work items, started by a
[schedule](/scarn/guides/automations/#schedules).

## 1. Reach the source

Call the tracker from `fn` however suits it. An
[MCP server](/scarn/guides/steps/#calling-mcp-tools-from-a-code-step) keeps
its credentials on the worker, out of the step's container. Whatever you use,
you need a way to list tickets **updated since** a time, **oldest first**, a
page at a time.

## 2. Write the step

```typescript
// .scarn/pipeline-builder/acme-import.ts
import { defineAutomation, onEvent } from "@scarn/sdk/automations";
import { codeStep, Features, z } from "@scarn/sdk/definitions/steps";
import { listAcmeTickets } from "./acme";

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

export default defineAutomation({
  key: "acme-import",
  title: "Acme import",
  scope: "project",
  rules: [
    onEvent({
      key: "import",
      event: "schedule",
      cron: "*/5 * * * *",
      to: () => importAcme({}),
    }),
  ],
});
```

What each piece does:

- **The grants.** `create` lets the step add new keys, `update` lets it
  change keys it imported before, and `read` gives it the cursor.
  `keyPrefix: "acme:"` stops it touching anything else.
- **The cursor.** `latestSourceUpdate` returns the newest `sourceUpdatedAt`
  the project holds under `acme:`, or `null` on the first run, when you
  decide how far back to go. Five minutes of overlap covers tickets updated
  in the same second.
- **Ascending pages.** Upsert each page as you read it, oldest first. If the
  run fails halfway, the next one carries on from the last saved page.
- **No duplicates.** `upsert` is keyed by `platformKey` and only overwrites
  with newer data, so re-reading a ticket changes nothing. Keep each page at
  100 items or fewer.

Export the step by name from this file: the worker re-imports it to run the
step.

## 3. Test it

Unit test `fn` with
[`createFakeWorkItems`](/scarn/guides/steps/#writing-work-items-from-a-code-step),
which follows the same grant rules. Then push, run it once, and enable it:

```bash
scarn pipelines push
scarn automations run acme-import import
scarn automations enable acme-import
```

The run happens on a worker, as the user who started it, and that user needs
write access to work items in the project. A missing grant or permission
fails the run with `WorkItemsRefusedError`, and the schedule on
**Pipelines & Automations** shows it. See
[Importing work items](/scarn/guides/automations/#importing-work-items) for
the full rules.

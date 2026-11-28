---
title: Let an agent ask for access
description: Let a Task's agent ask for more work item access mid-Task, and approve or deny it
---

A step's agent starts with the work item access its step grants. When it
needs more — to comment, add a label, or create child work items — it can ask,
and wait for you to say yes, some, or no.

## Which Tasks can ask

- **Prompt Tasks** you start on a work item: always.
- **Step Tasks**, standalone or in a pipeline: when the step has
  `Features.grantRequests()`.

The work item must be a Scarn work item (not one synced from GitHub,
Bitbucket or Jira), and a person must have started the Task. Scheduled Tasks,
Tasks an automation started, and code or MCP tool steps can't ask: nobody may
be watching.

## Turn it on for a step

In an [edit session](/scarn/how-to/change-a-pipeline/), ask for it — it's a
**tweak**. By hand, add the feature next to the grants the step already has:

```typescript
import { defineStep, Features } from "@scarn/sdk/definitions/steps";

export const triage = defineStep({
  key: "triage",
  name: "Triage",
  agentPrompt: "Triage this report.",
  features: [
    Features.workItems.read({ scope: "self" }),
    Features.grantRequests(),
  ],
});
```

Then push it. See [Features](/scarn/guides/steps/#features) for every grant
an agent can hold, and ask for.

## Answer a request

The agent names what it needs and why, then hands the Task over to you. The
Task waits (`waiting_for_person`) and you're notified, as for any hand-over.

**In the dashboard**, the conversation shows "The agent is asking for more
access": each requested grant as a sentence, with its labels. Untick grants or
remove labels you don't want to give, add a note if you like, then
**Approve selected** or **Deny**.

**From a terminal:**

```bash
scarn tasks view 0196a000-0000-7000-8000-0000000000c1
scarn tasks access 0196a000-0000-7000-8000-0000000000c1 --approve --only create:children --labels bug
scarn tasks access 0196a000-0000-7000-8000-0000000000c1 --deny --note "Comment instead."
```

`scarn tasks view` lists the grants as `action:scope`, the form `--only`
takes. See [`scarn tasks access`](/scarn/reference/cli/#scarn-tasks-access-taskid).

Either way the Task resumes, and the agent's first message tells it what you
decided, the tools it now has, and your note. Replying or pressing Continue
instead leaves the request unanswered: nothing is granted.

Approving needs the same access as Continue, plus permission to change work
items for anything beyond reading.

## What you're agreeing to

- **This Task only.** Approved access stays with the Task, across its
  retries. It never changes the step; a rerun starts from the step's grants.
- **Nothing changes until the Task succeeds.** Work item changes the agent
  records are held, even across hand-overs, and applied when the Task
  succeeds. If it fails or is cancelled, they're dropped. A child work item is
  the exception: it exists as soon as the agent creates it.
- **The agent can ask again.** Each request uses one of the Task's turns.

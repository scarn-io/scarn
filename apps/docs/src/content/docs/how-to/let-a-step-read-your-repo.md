---
title: Let a step work inside your repo
description: Choose repository access policy and use your project's devcontainer toolchain
---

```bash
scarn pipelines design
```

Tell the designer which step needs your code, and what it should do with it —
read it, run the tests, or change it.

## Where a step runs

Every step has a [runtime](/scarn/getting-started/concepts/#runtime):

- **`Runtime.devcontainer()`** — runs the agent inside your project's container.
- **`Runtime.managed.<id>()`** — runs it inside a worker-supplied container.
- **`Runtime.host()`** — runs it on the worker host without Docker.

Every runtime gets a repository checkout, including host. Choose a devcontainer
when the step needs your project's installed toolchain or services, not merely
to read files. See [environment defaults](/scarn/guides/environments/#defaults).

## Move the step into the devcontainer

In an [edit session](/scarn/how-to/change-a-pipeline/), ask for the change
— it's a **tweak**. Ask for `Runtime.devcontainer()` explicitly when the step
needs that toolchain, and describe how its prompt should use the code.
By hand:

```typescript
import { defineStep, Repo, Runtime } from "@scarn/sdk";

export const triage = defineStep({
  key: "triage",
  name: "Triage",
  environment: { runtime: Runtime.devcontainer() },
  repo: Repo.readOnly(),
  agentPrompt: "Find the code behind this report and summarize it.",
});
```

Add `repo: Repo.readOnly()`, as here, when the step only reads code; leave
`repo` off when it changes code, and its work is committed to a work branch.
See [Repo access](/scarn/guides/steps/#repo-access).

For the designer's devcontainer setup behavior, see
[Runtime](/scarn/getting-started/concepts/#runtime). To write or adjust one yourself, see
[Set up a dev container](/scarn/how-to/devcontainer/); for a different
config per step, see
[Selecting a devcontainer config](/scarn/guides/steps/#selecting-a-devcontainer-config).

## What you need from here

- **Docker**, running wherever `scarn work` runs. Host steps never needed
  it; devcontainer steps do.
- **The config on your remote.** The worker reads it from the clone, so commit
  and push `.devcontainer/` on the branch the step starts from (see
  [Base branch](/scarn/guides/workers/#base-branch)).
- **Keep secrets on the worker.** All runtimes use the same worker-variable
  lookup policy. See
  [Secrets](/scarn/guides/steps/#secrets).

## Verify it

```bash
scarn work --dry-run
```

Pick the step when asked. The dry run brings up the same devcontainer and
OpenCode runtime a real run would and reports their health, without running
the step's prompt. Because the designer never builds the image, this — or
your next real run — is the first time it's built; if that fails, suspect the
container before the pipeline. Flags: [`scarn work`](/scarn/reference/cli/#scarn-work-project)
and [What a dry run tests](/scarn/reference/cli/#what-a-dry-run-tests).

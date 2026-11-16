---
title: Environments
description: Share runtime and variable configuration across steps
---

An environment selects a runtime, environment variables, and
[connectors](#connectors). It has no branch: see [Branches](#branches). Use a **named environment** for configuration shared across steps, or
an **inline environment** for step-specific settings and input-dependent values.
Repository write policy is separate: set `repo` on the step, not inside
`environment`. Every runtime, including host, gets a repository checkout.

## Use a named environment

Define it with `defineEnvironment` in any `.ts` file in
`.scarn/pipeline-builder/`, next to your steps:

```typescript
// .scarn/pipeline-builder/environments.ts
import {
  defineEnvironment,
  Env,
  Runtime,
} from "@scarn/sdk/definitions/environments";

export const review = defineEnvironment({
  name: "review",
  description: "Shared review tools",
  runtime: Runtime.managed.bun1(),
  connectors: ["playwright"],
  vars: {
    BASE_URL: "https://staging.example.com",
    SERVICE_TOKEN: Env.secret("SERVICE_TOKEN"),
  },
});
```

`defineEnvironment` takes `name`, and optionally `description`, `runtime`,
`vars` and `connectors`. It returns an **environment handle**. Pass
the handle to a step, or name the environment as a string:

```typescript
import { defineStep, Repo } from "@scarn/sdk";
import { review } from "./environments";

export const reviewStep = defineStep({
  key: "review",
  name: "Review",
  environment: review, // or "review"
  repo: Repo.readOnly(),
  agentPrompt: ({ env }) => `Review the app at ${env.BASE_URL}.`,
});
```

Both forms store the same step. The handle adds two things:

- The prompt's `env` is typed from the environment's declared, non-secret
  `vars`. With a name, `env` is `Record<string, string>`.
- Some mistakes fail as soon as the step is defined: a code step given a host
  environment, or a step `mcps` key equal to one of the environment's
  connector ids. With a name, these are caught when you push or when the run
  starts.

Names use lowercase letters, digits, and hyphens, starting with a letter or
digit. `vars` is a record only: an environment is shared by steps with
different inputs, so it has no function form and no `{{input.…}}` templates.
`defineEnvironment` runs the same checks as inline settings (no static
secrets, no `setup` vars on host, known connector ids) and also checks that
`vars` gives every connector the variables it needs.

### Push and versions

[`scarn pipelines push`](/scarn/reference/cli/#scarn-pipelines-push-project)
uploads every environment it finds before it uploads steps. Scarn stores each
environment per project, with numbered versions. Content identical to the
latest version publishes nothing:

```text
✓ environment review v3 → published (environments.ts)
```

A run uses the latest version of its environment when a worker claims it. To
change the shared configuration, edit the definition and push again; the next
new Task uses it. **You do not need to re-publish the pipeline.** A
continuation, reply or retry of an existing Task keeps the version its first
run used.

Names are checked when you publish. Pushing a step that names an environment
the project doesn't have fails, as does a step `mcps` key equal to one of the
environment's connector ids. The run still checks both when it starts, because
the environment can change after the step is published.

Removing a definition from your files doesn't delete the environment from
Scarn. Deleting is an API call, `DELETE /projects/:projectId/environments/:name`.
It is refused while an active step names the environment. A deleted name can be
used again, and its version numbers carry on. A run that names a deleted
environment fails with `SCARN_ENVIRONMENT_NOT_FOUND`; it never silently selects
another environment.

## Use inline settings

Inline configuration is published with the step. It accepts `runtime`, `vars`
and `connectors`; `vars` can be a record or a function of the typed input:

```typescript
import { defineStep, Runtime } from "@scarn/sdk";
import { z } from "zod";

export const inspect = defineStep({
  key: "inspect",
  name: "Inspect",
  input: z.object({ targetUrl: z.string() }),
  environment: {
    runtime: Runtime.managed.bun1(),
    vars: ({ input }) => ({ TARGET_URL: input.targetUrl }),
  },
  agentPrompt: ({ env }) => `Inspect ${env.TARGET_URL}.`,
});
```

Unlike named environments, inline variable functions retain input templates.
Change inline settings by pushing the step definition again. See
[`Env`](/scarn/reference/sdk/#env) for variable helpers,
[Project secrets](/scarn/guides/secrets/) for credentials saved in Scarn, and
[Secrets](/scarn/guides/steps/#secrets) for worker credentials.

## Connectors

`connectors` turns on MCP servers from the
[connector catalog](/scarn/reference/connectors/) by id, for every step that
uses the environment. Each connector names the variables it needs, and the
environment's `vars` must provide them (a `secret`, `worker` or fixed value).
Connectors and the step's own `mcps` merge into one set of MCP servers; a step
`mcps` key that equals a connector id is an error.

Before the first prompt, the worker waits up to 60 seconds for every connector
and every server in the step's `mcps` to report `connected`. A server that
reports `failed`, `needs_auth` or `disabled`, is still `pending`, or never
registers with OpenCode fails the run with `SCARN_CONNECTOR_UNAVAILABLE`. The
failure lists each server, its status and OpenCode's error. This runs whether
or not the step declares health checks; declared checks run after it. Servers
that only appear in the repository's own OpenCode config are not checked.

## Defaults

| Step configuration                                                    | Runtime selection    |
| --------------------------------------------------------------------- | -------------------- |
| Agent step, `environment` omitted                                     | Repository discovery |
| Agent step, inline environment without `runtime`                      | Repository discovery |
| Code step, `environment` omitted                                      | Managed `bun1`       |
| Code step, inline environment without `runtime` (including vars-only) | Managed `bun1`       |
| Either step, named environment without `runtime`                      | Repository discovery |

**Repository discovery** checks `.devcontainer/devcontainer.json`, then root
`devcontainer.json`, in the selected code checkout. If neither exists, it uses
managed `bun1`. A discovered but malformed config or a failed container build
fails the run, rather than falling back.

An explicit `Runtime.devcontainer()` requires one of those canonical configs.
An explicit config path must exist and be valid; missing, malformed, or failing
explicit configs never fall back. Code steps cannot resolve to host, including
through a named environment. `repo` defaults to `Repo.readWrite()` for every
runtime; use `Repo.readOnly()` when the worker should not commit or push.

## Branches

Environments have no branch. A step's repo settings pick the branch it starts
from and the branch it commits to; see [Branches](/scarn/guides/steps/#branches)
and the order in [Base branch](/scarn/guides/workers/#base-branch). A
`baseBranch` can read a variable declared here with `{{env.X}}`.

A named environment is read from Scarn, never from Git. Its devcontainer stays
in your repository: `runtime`'s devcontainer path is resolved in the selected
code checkout when the run starts, so the config must exist on that branch.

## Validation and diagnostics

`scarn pipelines push` checks environments offline before any upload. A step
that names an environment by string must name one defined in the builder
directory or already in Scarn; otherwise the push fails before uploading
anything. The worker validates the environment again when preparing execution.

Runtime diagnostics identify the environment source, its version, the
resolved runtime, checkout branch, variable names and sources (`value`,
`worker`, `secret:worker` or `secret:scarn`) and connector ids—not values.
Use [`scarn work --dry-run`](/scarn/reference/cli/#what-a-dry-run-tests) to inspect
the resolved runtime before executing a prompt. The dry run also prints where each `secret` variable would come from and each
gated MCP server's status. It never fetches secret values.

## Failure codes

These codes stop a run before the agent gets its prompt. The run's failure
message names the variables or servers involved, never values.

| Code                           | What happened                                                                                                                                                                                                                                                                   | How to fix it                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCARN_ENVIRONMENT_NOT_FOUND`  | The step names an environment that isn't in Scarn, for example because it was deleted after the step was published                                                                                                                                                              | Define the environment with `defineEnvironment` and run `scarn pipelines push`, or point the step at another environment and push again                                                                                                        |
| `SCARN_ENVIRONMENT_UNRESOLVED` | A required `worker` variable is not set on the worker, or a `secret` variable's name is in neither `.scarn/.env` nor the project's secrets, or the request to Scarn for secrets failed, or a `{{env.X}}` in the step's `baseBranch` names a variable that isn't declared or set | Set the `worker` variable in `.scarn/.env` or the worker's environment, or mark it `optional`. Save the secret in [project settings](/scarn/guides/secrets/#save-a-secret) or set it in `.scarn/.env`. If Scarn was unreachable, retry the run |
| `SCARN_REPO_BRANCH_INVALID`    | The step's `baseBranch` rendered empty or to an invalid branch name, or names a secret variable, or `WorkBranch.base()` would commit onto a base the step didn't name                                                                                                           | Fix the template or the variable it reads. For `WorkBranch.base()`, set an explicit `baseBranch` such as `"main"`. See [Base branch](/scarn/guides/workers/#base-branch)                                                                       |
| `SCARN_CONNECTOR_VARS_MISSING` | A connector needs variables the environment's `vars` don't give the agent. A var with `applies: "setup"` doesn't count                                                                                                                                                          | Add each named variable to `vars`, from a `secret`, a `worker` variable or a value, with `applies` `agent` or `both`. The [catalog](/scarn/reference/connectors/) lists what each connector needs                                              |
| `SCARN_ENVIRONMENT_INVALID`    | The environment has an invalid field, lists an unknown or repeated connector id, or a step `mcps` key equals a connector id                                                                                                                                                     | Fix the field the message names. For a clash, rename the step's MCP server or drop the connector. Inline environments and environment handles report this when you define or publish the step; names when you publish and when the run starts  |
| `SCARN_CONNECTOR_UNAVAILABLE`  | A connector or step `mcps` server didn't report `connected` within 60 seconds of startup                                                                                                                                                                                        | Read each server's status and error in the message. Check its variables hold valid credentials, that its command or URL works from the runtime, and that it doesn't need interactive auth. Run `scarn work --dry-run` to see the status        |

---
title: Project secrets
description: Save credentials in Scarn and hand them to steps at run time
---

A **project secret** is a named value saved in Scarn, such as an API key. An
environment asks for it by name with a `secret` variable. At run time the worker
reads the value from its own `.scarn/.env` first, and asks Scarn only for the
names it doesn't have. A team can then share one credential without copying it
onto every worker.

## Save a secret

Open the project's **Settings** and go to **Secrets**. The table lists each
secret's name, the last four characters of its value (`••••abcd`), who updated
it and when, and when a run last used it. From there you can add a secret,
replace its value, rename it or delete it.

- **Names** use environment-variable syntax, `[A-Z_][A-Z0-9_]*`, up to 100
  characters. Names starting with `SCARN_` and other
  [reserved names](/scarn/reference/sdk/#env) are rejected. A name is unique in
  the project.
- **Values** are write-only. No page or API route returns a saved value.
- **Rename and delete** warn you first. An environment that still uses the old
  name fails to start on any worker that doesn't set that name in its own
  `.scarn/.env`.

| Role                             | Can see names (`secrets:read`) | Can add, change or delete (`secrets:write`) |
| -------------------------------- | ------------------------------ | ------------------------------------------- |
| Project admin                    | Yes                            | Yes                                         |
| The user who created the project | Yes                            | Yes                                         |
| Every other project role         | Yes                            | No                                          |

## Use a secret in an environment

Use [`Env.secret`](/scarn/reference/sdk/#env) in a named environment's `vars`
or in an inline environment. The record key is the variable name; the argument
is the secret name:

```typescript
export const staging = defineEnvironment({
  name: "staging",
  vars: {
    DD_API_KEY: Env.secret("DD_API_KEY"),
    DB_PASSWORD: Env.secret("STAGING_DB_PASSWORD", { applies: "both" }),
  },
});
```

Only the secret's name is stored in the definition. A `secret` variable has no
`default` and is always masked. See [`Env`](/scarn/reference/sdk/#env) for the
`applies` scopes.

## Where the value comes from

For each `secret` variable, the worker looks up the **secret name**:

1. In the project's `.scarn/.env` on the worker. A value there wins, so a
   developer can use their own key without touching the shared one.
2. Otherwise in Scarn. The worker makes one request per run, for the names
   `.scarn/.env` didn't have. Scarn returns only secrets that the run's
   environment names in a `secret` variable: the named environment version the
   run uses, or the step's inline environment. A request for any other secret
   is refused.

The worker's `process.env` is not read for `secret` variables. It still is for
`worker` variables.

Values are kept in memory for that run only. A changed value in Scarn applies
from the next run.

If a name is in neither place, or the request to Scarn fails, the run stops
before anything launches with `SCARN_ENVIRONMENT_UNRESOLVED`. See
[Failure codes](/scarn/guides/environments/#failure-codes).

## How values reach the step

- **Containers:** each value is passed as `docker exec -e NAME`, with the value
  in the `docker` process's own environment. It never appears in the command
  line, `devcontainer.json`, the OpenCode config or on disk.
- **Host runs:** the value is set in the environment of the OpenCode process
  the worker starts.
- **Setup:** values with `applies: "setup"` or `"both"` go to the environment
  of `devcontainer up`.
- **Logs:** every value is registered with the log masker before the runtime
  starts. Values shorter than 4 characters are not masked.

The run record lists each variable's source (`value`, `worker`,
`secret:worker` or `secret:scarn`), never its value.
[`scarn work --dry-run`](/scarn/reference/cli/#what-a-dry-run-tests) shows
where each secret would come from and never fetches one:

```
Secret DB_PASSWORD (STAGING_DB_PASSWORD): will request from Scarn
Secret DD_API_KEY: from .scarn/.env
```

## What secrets do not protect against

:::caution[Read this before you save a secret]

- **There is no approval step.** Any run in the project can use a secret,
  including runs on pull-request branches. A branch that adds a `secret`
  variable gets the value on its next run.
- **Any run can ask for any secret by name.** The server checks that the
  worker holds a valid claim in the project. It does not read the environment
  file, so it cannot check that the step actually declared that name.
- **The agent can read every value it is given.** Masking hides values in logs
  only. The agent can run `env` and see them, and may repeat them in its
  output.

Save only credentials you are willing to give to every step in the project.
Scope them as narrowly as the service allows, for example a read-only key.
:::

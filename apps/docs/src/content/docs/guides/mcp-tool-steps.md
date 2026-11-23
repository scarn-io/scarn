---
title: Build a library of MCP tool steps
description: Pull an MCP server's tools into a typed catalog, bind it to a server, and call its tools as pipeline steps with no LLM.
---

An **MCP tool step** calls one tool on one MCP server, with no agent and no LLM. The worker renders the tool's arguments from the step's input, calls the tool and hands its result on as the step's result. Pipelines call it like any other step, and the input and result are type-checked.

Use a tool step when the work is one call whose arguments come straight from earlier results or the work item: look up a record, search issues, create a page. Use an [agent step](/scarn/guides/steps/) with the server under `mcps` when the work needs judgement or reading free text. For several calls whose order follows fixed logic, use a code step that [calls the tools itself](#tool-step-or-code-step).

The workflow:

1. [Pull](#pull-the-servers-catalog) the server's tools into a typed catalog.
2. [Bind](#bind-the-catalog-to-a-server) the catalog to your `defineMcp`.
3. [Write steps](#write-steps) with `.tools.<tool>.step()`.
4. [Call them from a pipeline](#call-them-from-a-pipeline) and route on their results.

## Pull the server's catalog

Never write a tool's schema by hand. `scarn mcp pull` lists the server's tools and writes two files into `.scarn/pipeline-builder/mcp/`:

| File                 | What it is                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `<server>.lock.json` | The raw `tools/list` snapshot: each tool's name, title, description, input and output schemas, plus a content hash |
| `<server>.tools.ts`  | Generated from the lock. Exports `<server>Tools` (camel case, e.g. `notionTools`), built with `mcpToolCatalog`     |

Commit both, and never edit them; pull again instead. `scarn pipelines push` doesn't read the `mcp/` directory, and the pull writes no connection config and no secrets.

```bash
scarn mcp pull notion                 # a server in your repository's MCP config, or a defineMcp's name
scarn mcp pull --handle mcps.ts#notion # the defineMcp handle a builder file exports
scarn mcp pull --all                  # re-pull every server that already has a lock
```

A server is found the same way a step's [`ref`](/scarn/guides/steps/#referencing-a-server-from-your-repository) is, and its `{env:VAR}` values are read from `.scarn/.env` and your shell. A server authenticated by a project connection (`auth: { connection }`) is listed through Scarn, so pass `--project <owner/slug>` when `.scarn/scarn.jsonc` names none. See [`scarn mcp pull`](/scarn/reference/cli/#scarn-mcp-pull-server).

The generated file holds tool names and schemas only. Each tool becomes a camel-cased key (`notion-create-pages` → `createPages`); names that collide get a numeric suffix and a warning. JSON Schema features the generator can't turn into zod (such as `patternProperties`) become `z.unknown()` in the types, but the original JSON Schema is embedded and still validates in full at run time.

## Bind the catalog to a server

Your own `defineMcp` stays the only place the server's connection is configured. `.withTools(catalog)` returns a new handle whose `tools` holds one reference per catalog entry:

```typescript
// .scarn/pipeline-builder/mcps.ts
import { defineMcp } from "@scarn/sdk/definitions/steps";
import { notionTools } from "./mcp/notion.tools";

export const notion = defineMcp({
  type: "ref",
  name: "notion",
  auth: { connection: "notion" },
}).withTools(notionTools);
```

| To change…                                     | Edit…                               |
| ---------------------------------------------- | ----------------------------------- |
| How to connect (ref or remote, auth, env, URL) | your `defineMcp` call               |
| Which tools exist and their schemas            | nothing; run `scarn mcp pull` again |

A catalog isn't tied to a server, so one catalog can bind to several handles, for example a local server in development and a remote one in production. Calling `.withTools()` again replaces the catalog.

A tool step runs no [health checks](/scarn/guides/steps/#health-checks): connecting is the check. A handle that declares checks is rejected, so bind `.disableAllChecks().withTools(...)` for tool steps and keep the checked handle for agent steps.

## Write steps

### Pass-through

With no options, the step's input is the tool's arguments and its result is the tool's result:

```typescript
import { notion } from "./mcps";

export const notionSearch = notion.tools.search.step();
```

The key defaults to `<server>-<tool>` in kebab case (`notion-search`), where the server part is the handle's `name`. `name` and `description` default to the tool's. Set `key` when the default is too long or when one tool backs several steps.

### Adapted

`args` maps the step's own input onto the tool's arguments. With `args`, `inputSchema` is required (`z.object({})` when the step takes nothing); without `args`, `inputSchema` isn't allowed.

```typescript
import { z } from "@scarn/sdk/definitions/steps";
import { notion } from "./mcps";

export const fileBugPage = notion.tools.createPages.step({
  key: "file-bug-page",
  inputSchema: z.object({ title: z.string(), summary: z.string() }),
  args: ({ input, env }) => ({
    parent: { page_id: env.NOTION_BUGS_PAGE },
    pages: [
      { properties: { title: `Bug: ${input.title}` }, content: input.summary },
    ],
  }),
  environment: { vars: { NOTION_BUGS_PAGE: "abc123" } },
});
```

`args` is typed against the tool's input, so a missing or misspelled argument is a type error.

| Option                                                            | Description                                                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `key`, `name`, `description`, `version`                           | As for [`defineStep`](/scarn/guides/steps/#definestep-options). `version` defaults to 1 |
| `inputSchema`                                                     | The step's own input. Only with `args`                                                  |
| `args`                                                            | `({ input, env }) => toolArgs`, compiled to an [args template](#what-args-can-express)  |
| `environment`, `repo`, `status`, `errors`, `retry`, `concurrency` | As for `codeStep`                                                                       |

### What `args` can express

`args` runs once, when the step is defined, with stand-ins for `input` and `env`. Its return value is saved as an **args template** and rendered by the worker for each run.

- A bare `input.labels` (or `env.X`) passes the value with its type: a number stays a number, an array stays an array. A missing value drops the key.
- Inside a template string (`` `Bug: ${input.title}` ``) the value is interpolated as text; a missing or null value becomes `""`.
- `env` is the step's declared non-secret vars. A secret can't be templated: give it to the server through its `environment` or `headers`, so it stays out of the Task's input and logs.
- Arithmetic, `<`, `>` and `==` comparisons, method calls (`input.title.toUpperCase()`, `input.labels.map(...)`) and spreads throw when the step is defined. Compute the value in a [`codeStep`](/scarn/guides/steps/) before the tool step.

:::caution[Never branch on `input` or `env` inside `args`]
Truthiness checks and `===` can't be caught. The stand-in is always truthy, never null, and equal to nothing, so `input.x ? a : b`, `input.x && a`, `input.x || "default"` and `if (input.x)` always take the "set" branch, and `input.x === "a"` is always false, whatever the value at run time. Instead, make the field optional and pass it bare, so a missing value drops the key and the tool's default applies; or route in the pipeline to two tool steps with different keys; or compute the value in a `codeStep`.
:::

Before connecting, the worker validates the rendered arguments against the tool's input schema. A mismatch fails the step with `Scarn.ArgsError`.

### The result

The result shape is fixed when the step is defined:

| The tool…                 | The step's result                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| declares an output schema | Its `structuredContent`, typed by that schema: `r.result.results[0].title`               |
| declares none             | `{ content: ContentBlock[], structuredContent: object \| null }`, the MCP content result |

When there's an output schema, a missing or non-matching `structuredContent` fails the step with `Scarn.McpOutputInvalid`. With no output schema, `structuredContent` is kept whenever the server sends one. To route on the text of an unstructured tool, index into `content` or add a `codeStep` that parses it.

A result over 1 MiB (serialized) fails the step with `Scarn.McpOutputInvalid`. `image` and `resource` content blocks are kept in the result but not saved as artifacts.

## Call them from a pipeline

A tool step is an ordinary step handle:

```typescript
flow: [
  triage.next((r) => notionSearch({ query: r.result.title })),
  notionSearch.next((r) =>
    fileBugPage({ title: r.input.query, summary: r.result.results[0].title }),
  ),
  fileBugPage.next(done),
],
```

[Push](/scarn/reference/cli/#scarn-pipelines-push-project) publishes every step a pipeline uses, whether it's exported or created inline, deduplicated by key. Tools in a catalog that no pipeline uses are never published. Two different steps with the same key fail the push, naming both. A `codeStep` must still be exported, because the worker re-imports it by file.

## Errors, retry and catch

A tool step fails with a built-in error a pipeline can [`retry` or `catch`](/scarn/guides/pipelines/#errors-retries-and-timeouts):

| Error                       | When                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Scarn.ArgsError`           | The rendered arguments don't match the tool's input schema; checked before connecting                            |
| `Scarn.McpToolError`        | The tool returned an error. The message is its text, up to 2,000 characters                                      |
| `Scarn.McpUnavailable`      | The server couldn't start, connect or initialize, or has no such tool                                            |
| `Scarn.McpOutputInvalid`    | `structuredContent` is missing or doesn't match the output schema, or the result is over 1 MiB                   |
| `Scarn.Timeout`             | The call ran past the smaller of the server's `timeout.execution` and the step's timeout (10 minutes by default) |
| `ManagedConnectionNotReady` | A server authenticated by a project connection whose connection isn't ready                                      |

A call that reached the server is never retried for you, because a tool may not be idempotent; only a connection that fails before the call is sent is retried once. `Scarn.McpUnavailable` is safe to retry. Retry `Scarn.McpToolError` only for a read-only tool:

```typescript
notionSearch
  .retry({ on: ["Scarn.McpUnavailable"], maxAttempts: 3 })
  .catch(["Scarn.McpToolError", "Scarn.ArgsError"], (r) =>
    reportFailure({ reason: r.error.message }),
  )
  .next(done),
```

A tool step takes no messages and has no transcript. It can be cancelled: cancelling the run stops the call and the server it started. Its task log shows the call without argument values or content:

```text
mcp: starting notion (managed)
mcp: notion.notion-search called in 0.8s (ok)
```

The transport is `local`, `remote` or `managed`; the outcome is `ok`, `tool_error`, `unavailable:<reason>`, `timeout` or `aborted`.

## Where it runs

The MCP client always runs in the worker process. Only the server's own process runs in the step's runtime:

| Server                              | Default runtime          | Where the call happens                                                            |
| ----------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `local` (stdio)                     | `Runtime.devcontainer()` | Started inside the container with `docker exec`; on the host for `Runtime.host()` |
| `remote`, or any server with `auth` | `Runtime.managed.bun1()` | From the worker host                                                              |
| `ref` without `auth`                | `Runtime.devcontainer()` | As for what the ref resolves to                                                   |

A stdio server launched with `npx`, `uvx`, `dotnet` or `java` needs that toolchain in its image, which `bun1` doesn't have. For a server that needs a specific image, point `Runtime.devcontainer({ config })` at a devcontainer.json that names it. A remote URL must be reachable from the worker host: a server listening on `localhost` inside the devcontainer isn't supported.

## Tool step or code step

The same catalog-bound handle also works in a [code step](/scarn/guides/steps/#calling-mcp-tools-from-a-code-step): declare it under `mcps` and call `context.mcp.<server>.<tool>(args)` from `fn`, with the same typed arguments and results.

| Use…                      | When                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.tools.<tool>.step()`    | One call, arguments taken straight from the input. No source file, so it can ship in a package. Routing happens in the pipeline                                          |
| `context.mcp` in `fn`     | Several calls, loops, paging, "search, then create if missing", or arguments that need computing. Logic lives in one function, which must be exported from a source file |
| An agent step with `mcps` | The work needs judgement or reading free text                                                                                                                            |

The two no-LLM kinds fail with the same built-in error names, so a pipeline's `retry` and `catch` treat them alike. They differ in two ways:

- A code step runs its servers' `defineMcp` health checks before `fn`; a tool step runs none.
- A code step keeps one connection per server for the whole run; a tool step connects for its one call.

## Share a catalog or a step library as a package

A catalog is plain data, so a team can publish one as a package (for example `@acme/scarn-mcp-notion`, exporting only `notionTools`) that each repository binds to its own `defineMcp`. Tool steps are plain data too, with no source file, so a package can also export ready-made steps, and a pipeline can import them from `node_modules`.

A package that exports catalogs or steps must list `@scarn/sdk` as a **peer dependency**, not a dependency. Steps are linked to pipelines inside the copy of `@scarn/sdk` that built them; a step from a second copy can't be used, and `definePipeline` fails with "it was built by a different copy of @scarn/sdk than definePipeline".

## Check for drift in CI

`scarn pipelines push` never connects to your servers. To catch a server whose tools changed since the lock, run the check in CI:

```bash
scarn mcp pull --check
```

It writes nothing, lists every locked server again and exits non-zero when one has added, removed or changed tools. It also warns when a handle binds a catalog pulled from a server with another name, which is fine for an alias. Pull again and commit the new lock and catalog to fix a drift. A drift that slips through fails at run time: a result that no longer matches the output schema fails the step with `Scarn.McpOutputInvalid`.

# @scarn/shared-core

Logic that both the server (`core`) and the worker/CLI need. Only code that
both sides use goes here. Contracts (what a document _is_) go in
`@scarn/sdk`, and server-only logic stays in `core`.

- `@scarn/shared-core/pipelines`: pipeline document logic, meaning the
  validator, condition evaluator, reference resolver and graph helpers. It
  is a separate entry so browser bundles (`pipeline-studio-ui`) don't pull
  in the formatters below.
- `@scarn/shared-core`: the gather-and-format logic behind the CLI's
  read commands, described below.

## Read commands

Fetch-and-format logic for the agent-facing debugging commands (`scarn runs`,
`scarn work-items`, and task logs), read through the Scarn API with a
caller-supplied authenticated client. Each command has a `gather*` function
that returns plain data (what `--json` prints) and a `format*` function that
renders it as text ending in a `→ scarn …` next-command hint, e.g.
`gatherRunList` / `formatRunList` (`src/gather-runs.ts`,
`src/format-runs.ts`). Each takes a narrow client type (`RunReadClient`,
`WorkItemReadClient`, `TaskLogsClient`) rather than the whole generated
client. `loadTaskLogLines` and `formatLogs` load and render a task run's
logs; the worker uses `loadTaskLogLines` too.

This package owns the logic, not the CLI command, because two different
"apps" — the CLI today, an MCP server later — need the same behavior, and
this repo's convention is that `apps/*` stay thin argv/protocol wrappers
while `packages/*` hold the reusable logic (e.g. `pipelines push`/`pipelines
pull`'s real logic lives in `packages/worker`, not inline in
`apps/cli/src/commands/pipelines.ts`).

## Why not `@scarn/sdk` or `packages/worker`?

Three packages in this repo talk to the Scarn API; each has a different
audience and a different reason to exist:

| Package                                             | Audience                                                                                                                | Abstraction level                                                                          | Release blast radius                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `@scarn/sdk`                                        | External pipeline-definition authors, published to npm                                                                  | Raw generated HTTP client (`createScarnClient`) plus pipeline-definition authoring helpers | Public: a breaking change ships to every consumer outside this repo |
| `packages/worker`                                   | The CLI's write-side executor — devcontainer/Docker orchestration, running a step, pushing/pulling pipeline definitions | Built on `@scarn/sdk`, adds auth, project config, and the whole Task runtime               | Internal, but large — depended on by `apps/cli` directly            |
| `packages/shared-core` (this package's root export) | A human or agent debugging why a pipeline run did what it did — read-only                                               | Built on `@scarn/sdk`, adds fetch-resolve-format logic for read-heavy flows                | Internal, narrow — no devcontainer/Docker/runtime dependencies      |

`@scarn/sdk` is a _published_ package for pipeline-definition authors —
different audience, different release discipline — so read logic
that only this repo's own CLI/MCP surface consumes doesn't belong there.

`packages/worker` is chartered as the write-side executor: it orchestrates
devcontainers and Docker to actually run a step. A lightweight future MCP
binary that only wants to answer "why did this run fail" shouldn't
have to pull in that whole runtime just to read a run's status — the
same reasoning that already keeps `packages/worker` (also built entirely on
`@scarn/sdk`) out of `@scarn/sdk` itself applies one level up here.

The read code depends only on `@scarn/sdk` for the generated client's
type (`ReturnType<typeof createScarnClient>`) — callers resolve
authentication and construct the client themselves (see
`apps/cli/src/lib/cli-api-client.ts`'s `connectApi`) and pass both in.

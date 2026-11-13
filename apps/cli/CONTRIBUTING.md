# Contributing to the scarn CLI

`apps/cli` is the Bun + TypeScript source of `@scarn/cli`, compiled to
standalone binaries for distribution. The user-facing README (what npm shows)
is `README.md`; everything for working on the CLI itself is here. User docs
live in `apps/docs` and are published at
<https://scarn-io.github.io/scarn/>.

## Project shape

```txt
apps/cli/
  src/
    index.ts              entry point
    cli.ts                command tree and top-level runner
    commands/             one module per top-level command (init, pipelines, work, …)
    lib/                  shared CLI logic: reporters, design session, preflight, …
    auth/                 browser helpers for sign-in
    templates/            assets embedded in the binary (design agent prompt, push script)
  script/
    build.ts              compiles the binaries in targets.ts
    targets.ts            single source of truth for platform targets
    publish.ts            publishes the npm packages
    link.ts               links a build onto your PATH
  bin/
    scarn               npm bin wrapper
    postinstall.js        install-time integrity check
  test/                   source-level tests
  compiled-binary-tests/  tests that run against the compiled binary
```

## Prerequisites

- Bun `1.4.0` or newer (the root `package.json`'s `packageManager`)

## Local development

Install dependencies from the workspace root:

```sh
bun install
```

Run the CLI directly from source:

```sh
bun run apps/cli/src/index.ts hello
bun run apps/cli/src/index.ts auth status
bun run apps/cli/src/index.ts worker start --foreground
```

## The background worker

`scarn work`, `scarn pipelines design` and `scarn worker …` all talk to one
background worker per machine and **instance**. The commands live in
`src/commands/worker/`; the worker itself is in
`packages/worker/src/work/worker-host/`. See "Background Worker" in
`docs/architecture.md`, the terms in `packages/worker/CONTEXT.md` and
`docs/adr/0004-background-worker.md`.

| Command                                    | What it does                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `worker start`                             | Starts the worker in the background (spawns `worker start --foreground`, detached) and waits for it.       |
| `worker start --foreground`                | Runs the worker in this terminal. The first Ctrl-C drains, the second forces.                              |
| `worker start --foreground --once [proj]`  | One claim pass for one project from this checkout; no control API, nothing saved. Used by the e2e tests.   |
| `worker stop [--force]`                    | Drains (or with `--force` aborts every run with `WORKER_STOPPED`) and waits for the process to exit.       |
| `worker status [--json] [--recent-runs n]` | The worker, its limits, each project, active and recent runs. Exits 3 when no worker runs.                 |
| `worker logs [project] [--run id] [-f]`    | Reads `worker.log` from disk, so it works when the worker is stopped.                                      |
| `worker config --max-concurrency <n>`      | Changes and saves the machine limit.                                                                       |
| `worker add [project]`                     | Adds this checkout's project, or updates its settings (`-c`, `-k`, `--work-item-id`, `--source-branch`).   |
| `worker remove <project>`                  | Removes a project and its saved settings; its running runs finish.                                         |
| `worker cancel <taskRunId> [--yes]`        | Cancels the run's Task on the server, then aborts the run on this machine at once.                         |
| `work [project]`                           | `worker start` (if needed) then `worker add`. `--dry-run` rehearses a task's environment in this terminal. |

Things to know while working on it:

- **Instances.** The instance is the name the CLI runs as (`scarn`, or
  `scarn-dev` for a linked dev build), or `SCARN_WORKER_INSTANCE`. Its state
  is in `~/.scarn/workers/<instance>/` (`worker.json`, `worker.lock`,
  `worker.log*`, `worker.stdio.log`) plus its rows in `~/.scarn/db.sqlite`.
  Use your own instance to test without touching your real worker:
  `SCARN_WORKER_INSTANCE=my-test bun run apps/cli/src/index.ts worker start`.
- **Versions must match.** Every command except `worker stop` refuses to talk
  to a worker of another version. A dev build bakes a build ID in at compile
  time (`__SCARN_CLI_BUILD_ID__`), so after rebuilding `scarn-dev`, run
  `scarn-dev worker stop && scarn-dev worker start`. Running from source has
  no build ID.
- **Startup crashes** show up in `worker.stdio.log`, not `worker.log`.

The CLI targets `https://app.scarn.io` by default. Point it at a local
server with `--base-url` or the `SCARN_BASE_URL` environment variable.
Credentials are stored in `~/.scarn/auth.jsonc`.

`SCARN_TELEMETRY_DEBUG=1` prints every telemetry payload to stderr;
`SCARN_TELEMETRY_DISABLED=1` turns reporting off for one invocation.

## Type checking

```sh
bun run --filter @scarn/cli typecheck
```

## Tests

```sh
bun run --filter @scarn/cli test
```

The tests spawn the CLI as a subprocess, so they do not require a global
install. `test` runs `test/` only. The `compiled-binary-tests/` suite compiles
real standalone binaries and runs separately:

```sh
bun run --filter @scarn/cli test:compiled
```

It is not part of `bun run validate` or CI's `Test` job. CI runs it in the
`cli-compiled` job when the CLI or a package bundled into it changes, and
before a public release.

## Build binaries

```sh
bun run --filter @scarn/cli build
```

This creates standalone binaries in `apps/cli/dist/` for:

- `scarn-darwin-arm64`
- `scarn-darwin-x64`
- `scarn-linux-x64`
- `scarn-linux-arm64`
- `scarn-windows-x64.exe`

## npm bin wrapper

The package publishes the `scarn` executable through `bin/scarn`.

- The wrapper detects the current platform and architecture.
- It runs the matching compiled binary when available.
- It prints a clear error when the current platform is unsupported or the
  expected binary is missing.

After building, run the wrapper locally:

```sh
./bin/scarn hello Connor
./bin/scarn auth status
```

## Releasing

`bun run --filter @scarn/cli publish:package` (`script/publish.ts`)
publishes one `@scarn/cli-<platform>-<arch>` package per target, then the
thin `@scarn/cli` package that depends on them. The main package ships only
`README.md`, `bin/`, and the bundled devcontainer CLI; this file stays in the
repo. See the module doc in `script/publish.ts` for why the CLI is split this
way.

The compiled files in `apps/cli/dist/` can also be uploaded as GitHub Release
assets for consumers who want a platform binary without npm.

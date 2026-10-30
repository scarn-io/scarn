---
title: CLI Reference
description: Complete reference for all scarn CLI commands and flags
---

## Platform binaries

The `@scarn/cli` npm package ships pre-compiled binaries for:

| Platform              | Binary                    |
| --------------------- | ------------------------- |
| macOS (Apple Silicon) | `scarn-darwin-arm64`      |
| macOS (Intel)         | `scarn-darwin-x64`        |
| Linux x64             | `scarn-linux-x64`         |
| Linux ARM64           | `scarn-linux-arm64`       |
| Windows x64           | `scarn-windows-x64.exe`   |

---

## Global flags

These flags apply to every command:

| Flag                | Description                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `--env-file <path>` | Env file to load (default `.env` in the current directory); `.scarn.env` there is loaded too |
| `--verbose`, `-v`   | Show full diagnostic logs alongside the UI                                                     |
| `--help`            | Show help for the current command                                                              |
| `--version`         | Print the CLI version                                                                          |

Neither env file overrides a variable that is already set.

`--base-url <url>` is a per-command flag, accepted by `auth`, `init`, `pipelines design`, `pipelines pull`,
`pipelines push`, and `work`. It overrides the API server URL; without it the CLI uses `SCARN_BASE_URL`,
then `https://app.scarn.io`.

---

## `scarn auth`

Manage authentication credentials. Every `auth` subcommand accepts `--base-url <url>`.

### `scarn auth login`

Start a device-flow browser login. Opens your browser; credentials are saved to `~/.scarn/auth.jsonc` on completion.

```bash
scarn auth login
```

### `scarn auth logout`

Remove stored credentials.

```bash
scarn auth logout
```

### `scarn auth status`

Show whether you are currently authenticated.

```bash
scarn auth status
```

### `scarn auth whoami`

Print the email address of the authenticated user.

```bash
scarn auth whoami
```

---

## `scarn init`

Interactive project setup: links this repository to a Scarn project, reports what the first design session
will need, and offers to start it. It writes no pipeline and no analysis of the repo — `pipelines design`
does both, and its agent reads the repository itself at the start of a session.

Project root: the nearest directory at or above the current one that contains `.git`, so it runs from any
subdirectory. `.scarn/` is read and written there.

```bash
scarn init
scarn init --work-item-id <id>
```

| Flag                  | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `--base-url <url>`    | Override the API server URL. Forwarded to `pipelines design` in step 7                          |
| `--work-item-id <id>` | Forwarded to `pipelines design` in step 7: design around this item instead of picking one       |
| `--no-studio`         | Forwarded to `pipelines design` in step 7: don't open the [studio](#the-studio) in your browser |

Runs in sequence:

1. Resolves the git repository and prints its root and its `origin` remote URL, before anything else.
   - Walks up to the first `.git` entry the way `git rev-parse --show-toplevel` does, so it works from a
     subdirectory or inside a submodule.
   - Any credential embedded in the remote URL is stripped before it is printed.
   - Stops if there is no `.git` at or above the current directory, or no `origin` remote.
   - If an earlier run left a `.scarn/` in the subdirectory you ran from, it points it out so you can
     delete it.
2. Signs you in: runs the device-flow login if you aren't signed in, or if your saved session is no longer
   valid. In a non-interactive terminal it stops and asks you to run `scarn auth login` instead.
3. Selects the project matched by the `origin` remote from step 1. If none matches, it creates one:
   - When the remote is a GitHub repository covered by one of **your own** GitHub App installations, it
     asks to create the project from that repo through the API — no browser — and imports its issues.
   - Otherwise it opens your browser to `/projects/new`, pre-filled with the detected repository, and polls
     every 3 seconds until the project exists. Press **Enter** to check immediately.
   - It gives up after 15 minutes. Finish creating the project in the browser and re-run `scarn init`; it
     finds the new project and carries on from there.
   - In a non-interactive terminal it prints the URL and exits instead.
   - The `/projects/new` page opens on its **Details** step with the repository URL filled in, then asks
     where the project's issues come from (see [Create a project](/scarn/how-to/create-a-project/)). For a
     GitHub repo, pick the GitHub App if it's offered: it keeps syncing issues in as work items. Installing the
     App from that page brings you back to it with your repo still filled in. Bitbucket and other hosts work
     the same way, with their own options.
4. Writes `.scarn/scarn.jsonc` at the repository root with the `project` as `owner/slug` — see
   [Project refs](#project-refs) (you can also add an optional `branchPrefix` — see
   [Work branches](/scarn/guides/workers/#work-branches)). An existing `.scarn/scarn.jsonc` is kept as
   it is. If the project's owner hasn't chosen a username yet, `init` stops and asks you to finish that in the
   web app first.
5. Checks the repository root for a `.devcontainer/devcontainer.json`; a missing one is a **notice, not an
   error** (see [Runtime](/scarn/getting-started/concepts/#runtime)).
6. Checks for an AI provider and reports it — a **notice, not a blocker**. It looks for a credential in
   OpenCode's own store (`opencode auth export --standalone`, using an already-downloaded runtime only), a
   leftover OpenCode v1 `auth.json`, or a recognized provider env var, without downloading the runtime. When there is none,
   `pipelines design` [connects one](#connecting-an-ai-provider) the first time it starts.
7. Asks `Design your first pipeline now?` and, on yes, runs
   [`pipelines design`](#scarn-pipelines-design-project) in-process with `--base-url`, `--work-item-id`,
   and `--no-studio` carried through. On no, or in a non-interactive terminal, it prints that command as the
   next step.

:::note
Installations made by other members of a GitHub org aren't visible to the
API path in step 3, so a repo covered only by a teammate's installation goes
through the browser instead.
:::

Re-running `init` on an already-configured project is safe: it re-checks the dev container and the provider
and offers the handoff again.

---

## Project refs

`work`, `pipelines design`, `pipelines pull`, and `pipelines push` take an optional `[project]`, written
`owner/slug` (e.g. `acme/web-app`) — the same pair as the project's web URL. Without it they read `project`
from `.scarn/scarn.jsonc`. Each command looks the ref up once before doing anything else:

| Failure            | Message                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Not `owner/slug`   | `"<ref>" is not a valid project. Expected "<owner>/<project-slug>", e.g. "acme/web-app".`                  |
| No such project    | `No project <ref>. Check "project" in .scarn/scarn.jsonc — the owner may have renamed their username.` |
| You're not allowed | `You don't have permission to <action> <ref>.` — e.g. `push pipelines to`, `run work for`                  |

A renamed username changes the ref, so update `project` in `.scarn/scarn.jsonc` when that happens.

---

## `scarn pipelines`

Manage pipeline and step definitions. All step and pipeline authoring lives inside `.scarn/pipeline-builder/`.

### `scarn pipelines design [project]`

Design pipelines interactively with an AI agent, then push them. This is the recommended way to author
pipelines: it heals every missing precondition itself, then hands your terminal to an OpenCode session whose
agent interviews you about one work item, writes the definitions, typechecks them, and pushes. When the
session ends it offers to run what it built. Re-run it any time; it iterates on what's there.

Project root: the nearest directory at or above the current one that contains `.git`, so it runs from any
subdirectory. `.scarn/` is read and written there.

```bash
scarn pipelines design
scarn pipelines design <owner/slug>
```

| Flag                  | Description                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--base-url <url>`    | Override the API server URL. `init` forwards its own                                                                          |
| `--work-item-id <id>` | Design around this work item and skip the picker — see [Choosing a work item](#choosing-a-work-item). `init` forwards its own |
| `--no-studio`         | Don't open the [studio](#the-studio) in your browser. `init` forwards its own                                                 |

#### What happens, in order

After checking for an [interactive terminal](#terminal-requirements), every step below heals itself. Steps
1–3 can prompt, so they all run before the slow, non-interactive steps 4–6.

1. **Sign in** — runs the device-flow login inline when you have no valid session.
2. **Project** — the positional argument, else `.scarn/scarn.jsonc`, else the project matching this repo's
   `origin` remote, written to `.scarn/scarn.jsonc`. It never creates a project — run `scarn init`.
   With no match, or no `origin`, it prompts for an `owner/slug` and uses it for this session only. See
   [Project refs](#project-refs).
3. **Work item** — see [Choosing a work item](#choosing-a-work-item).
4. **Builder directory** — scaffolds `.scarn/pipeline-builder/` at the project root. Errors if no directory
   at or above the current one contains `.git`.
5. **Dependencies** — installs them with the package manager matching the directory's lockfile, else `bun` or
   `npm` from your `PATH`.
6. **Repository tools** — finds the MCP servers and skills your repository defines and starts each server on
   your machine to list its tools, for the designer to offer your steps. A server missing a `requiredEnv`
   variable isn't started; a failure only warns.
7. **Runtime** — downloads Scarn's pinned OpenCode runtime the first time, with progress (see
   [Installation](/scarn/getting-started/installation/#requirements)).
8. **AI provider** — see [Connecting an AI provider](#connecting-an-ai-provider).
9. **Studio** — see [The studio](#the-studio).
10. **TUI** — launches the OpenCode TUI in `.scarn/pipeline-builder/` with an injected `pipeline-designer`
    agent, seeded with the work item. It reads the repository, interviews you goal-first, adapts the
    [default pipeline](/scarn/getting-started/concepts/#default-pipeline) (`bug-pipeline.ts`, already
    scaffolded by the builder-folder check) plus `default-pipeline-assignment.ts` in place, typechecks, then runs
    `scarn pipelines push`, [`build`](#scarn-pipelines-build-file) and
    [`publish`](#scarn-pipelines-publish-file).

When you exit the TUI it runs the [post-push dry run](#dry-runs), then [the run offer](#the-run-offer).

#### Choosing a work item

Every session designs around one real work item. `--work-item-id` loads that item and skips the picker; an id
that doesn't resolve in this project is reported and falls through to the picker. The picker lists the
project's 15 most recent items, plus _Search for a different item_ (re-queries by keyword) and _Paste a
link/id, or describe a new one_. That rung resolves a pasted id or ticket URL to an existing item, and only
creates a new one (platform `scarn`) when nothing matches. With no items yet, it goes straight to that rung.
Cancelling stops the session.

#### Connecting an AI provider

It checks for a credential the provisioned runtime's `opencode auth export --standalone` reports, a leftover
OpenCode v1 `auth.json` entry, or one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`. Steps
use the same credentials: the worker exports them in memory and injects them into each session's private
OpenCode server. With none, it names your installed AI tools and their [menu entries](/scarn/getting-started/quickstart/#connect-your-ai-tool),
runs `opencode auth login --standalone` for the provisioned runtime inline, and rechecks. Still nothing, and it
stops: re-run `design`, or export a key such as `ANTHROPIC_API_KEY` first. The injected config is layered over
`~/.config/opencode/opencode.json[c]` and omits `model`, so your configured model and provider are used.

#### The studio

After the preflight, just before the TUI takes the terminal, `design` opens the
[pipeline studio](#scarn-pipelines-studio) — a live graph of the definitions as the agent writes them — and
tells the agent it is there. It stays up through the run offer and its worker; if it can't start, `design`
warns and carries on without it. `--no-studio` skips it.

#### Dry runs

|           | Early                                                     | Post-push                                                       |
| --------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| When      | In the session, once the agent has read the repository    | After the TUI exits, before the run offer                       |
| What      | `work --dry-run --global-only`: container + OpenCode only | Container, OpenCode, MCP servers, declared health checks        |
| Scope     | Nothing step-specific — no pipeline is pushed yet         | **Every** step's health checks, one launch per distinct runtime |
| Blocking? | No. Runs in the background; reported near session end     | Yes. A failure means no run offer                               |

A post-push failure can't be fixed in the same session — the agent has already exited — so it is recorded and
surfaces automatically at the start of your next `pipelines design` session, before the interview. See
[declared health checks](/scarn/guides/steps/#health-checks).

#### The run offer

When the session exits cleanly, `design` asks _Run your new pipeline on “&lt;work item title&gt;” now?_. On
yes it queues a run of the assigned pipeline against that work item and runs the worker in this terminal.

| Situation                                                                                   | What happens                                                                       |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Pipeline assigned, any devcontainer it needs present, health checks passed                  | The confirm appears; accepting queues the run and runs the worker here             |
| You decline                                                                                 | Prints `scarn work <owner/slug> --work-item-id <id>` and notes nothing is queued |
| A step runs in your project's devcontainer and `.devcontainer/devcontainer.json` is missing | No offer: prints why, plus that same command                                       |
| No pipeline assigned to the project                                                         | No offer — the session never got as far as pushing one                             |
| A step's blocking health check fails the dry run                                            | No offer: prints why plus the same command; the next `design` session surfaces it  |
| The session did not exit cleanly                                                            | No offer. A non-zero designer exit code still passes through                       |

After declining, start a run from the work item in the dashboard and that command picks it up. Before the
worker starts, the offer says where a failed run goes: back to `scarn pipelines design`, to tell the agent
what happened. The worker absorbs a failing step or a devcontainer that won't build into its polling loop, so
this is said up front. It keeps polling until you stop it, because later steps queue as earlier ones advance.

#### Edit sessions

When definitions already exist, the agent states a change-size verdict and gets your confirmation before it
edits a file: **tweak** an existing pipeline, add a **route** in `default-pipeline-assignment.ts`, or create a
**new pipeline** — preferred in that order, escalating only when the cheaper change can't express the
difference. A pipeline that would duplicate most of an existing one's steps is a tweak or a route instead.
One confirmed change per session is the norm, not a limit.

#### The devcontainer

With no `.devcontainer/devcontainer.json`, the agent writes one before any pipeline file but never builds it —
see [Runtime](/scarn/getting-started/concepts/#runtime).

#### Permissions

The session is supervised, so shell commands run unattended — the agent needs your own test runner, typecheck,
and linter. `scarn pipelines push` is the exception: it always prompts, because that is when the steps
reach the server. `build` and `publish` run after it without prompting. Reading and searching are unattended repo-wide, but the agent may only _write_ to
`.scarn/pipeline-builder/` and `.devcontainer/`. Every other path — `package.json`, your source, CI config —
asks first. Network access and subagents ask too.

#### Terminal requirements

`design` needs an interactive terminal: it checks for one before anything else and errors out under a pipe, a
redirect, or a CI runner, because the TUI owns the terminal for the session.

### `scarn pipelines init`

Scaffold `.scarn/pipeline-builder/` with a starter `package.json`, `tsconfig.json`, the [default pipeline](/scarn/getting-started/concepts/#default-pipeline) (`bug-pipeline.ts` and its built `bug-pipeline.json`), and a `default-pipeline-assignment.ts` that routes every new work item to it, then edit them by hand. Use `scarn pipelines design` unless you specifically want to author everything yourself.

Project root: the current directory, which must contain `.git`. It does not walk up from a subdirectory.

```bash
scarn pipelines init
cd .scarn/pipeline-builder && npm install   # or bun/pnpm/yarn install
```

The scaffolded `package.json` includes a `typecheck` script (`tsc -p tsconfig.json`), so `npm run typecheck` in that directory validates your definitions before you push. Then, from the repository root, [`build`](#scarn-pipelines-build-file) the pipeline JSON and [`push`](#scarn-pipelines-push-project), which sends the steps and publishes the JSON.

The scaffolded `.gitignore` ignores only `node_modules/`, lockfiles, and `push.ts`. **Your pipeline and step definitions are source code — commit and review them.** Lockfiles are deliberately _not_ committed: `scarn pipelines push` picks its runtime from whichever lockfile it finds in that directory, so committing one would force every teammate onto the same package manager.

### `scarn pipelines studio`

Open a local, read-only, live graph of `.scarn/pipeline-builder/` in your browser. It starts a server on `localhost`, opens your browser to it, and watches the directory until you press **Ctrl+C**. Every time a file in it changes, the graph re-renders: each pipeline's nodes and transitions, a detail panel per node, and the same validation issues `scarn pipelines push` would report, coloured by severity. A file that fails to load is shown as broken without taking down the other pipelines.

```bash
scarn pipelines studio
scarn pipelines studio --port 4400
```

| Flag            | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `--port <port>` | Port to serve the studio on (defaults to a random free port) |

Project root: the current directory, which must contain `.git` or `.scarn`. It does not walk up from a subdirectory.

Before the server starts it checks:

| Check                        | If missing                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.scarn/pipeline-builder/` | Scaffolds it at the project root, the same starter files as [`pipelines init`](#scarn-pipelines-init)                                                   |
| Dependencies                 | **Not** installed for you. It stops and prints the command to run inside that directory (`bun install` / `npm install` / `pnpm install` / `yarn install`) |

:::note
Unlike `pipelines design`, `pipelines studio` does not install the builder's dependencies. Run `pipelines design` once, or install them yourself, before opening the studio on a fresh scaffold.
:::

The studio never contacts the Scarn server and needs no sign-in. It edits nothing: change the definitions in your editor or through `pipelines design`, and the graph follows.

`scarn pipelines design` opens the studio automatically for the length of its session (`--no-studio` to skip), so you only need this command to look at the graph on its own.

### `scarn pipelines pull [project]`

Fetch pipeline and step definitions from the server into `.scarn/pipeline-builder/`: steps as editable TypeScript, and each pipeline's active version as a `<key>.json` document. Pull doesn't write TypeScript pipelines. If the directory already contains files you will be prompted before they are overwritten.

```bash
scarn pipelines pull
scarn pipelines pull <owner/slug>
scarn pipelines pull --key bug-pipeline --version 3
```

| Flag               | Description                                                                         |
| ------------------ | ----------------------------------------------------------------------------------- |
| `--key <key>`      | Pull only this pipeline's JSON document, into `<key>.json` in the current directory |
| `--version <n>`    | With `--key`: pull this published version instead of the active one                 |
| `--out <file>`     | With `--key`: the file to write (defaults to `<key>.json`)                          |
| `--base-url <url>` | Override the API server URL                                                         |

What gets written:

| File                             | Description                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `package.json`                   | Declares `@scarn/sdk` and `zod` dependencies (only on first pull)           |
| `tsconfig.json`                  | TypeScript config scoped to the pipeline-builder package (only on first pull) |
| `.gitignore`                     | Ignores `node_modules/`, lockfiles, and `push.ts` (only on first pull)        |
| `steps.ts`                       | One `defineStep()` export per step definition (latest version of each key)    |
| `<pipeline-key>.json`            | Each pipeline's active version, as a JSON document                            |
| `default-pipeline-assignment.ts` | Project routing policy (written if configured on the server; removed if not)  |

After pulling, run `npm install` or `bun install` inside `.scarn/pipeline-builder/` to install dependencies. Edit the files, run `npm run typecheck` there to validate them, then [`scarn pipelines push`](#scarn-pipelines-push-project). The files are source code — commit them (see [`pipelines init`](#scarn-pipelines-init) for what the `.gitignore` leaves out).

### `scarn pipelines push [project]`

Push `.scarn/pipeline-builder/` to the server, in order:

1. Upsert every step definition.
2. Publish every built `<key>.json` pipeline document, as [`publish`](#scarn-pipelines-publish-file) would. A new key creates the pipeline; a document identical to its latest version publishes nothing. Run [`build`](#scarn-pipelines-build-file) first, or push publishes stale JSON.
3. Sync `default-pipeline-assignment.ts`, if present. Every pipeline it assigns must be on the server by now.

Every file is read and the steps are validated before the first write. Other `.json` files (`package.json`, `tsconfig.json`, any without `nodes`) are skipped. Absent files are ignored; they do not clear server configuration.

```bash
scarn pipelines push
scarn pipelines push <owner/slug>
```

| Flag               | Description                 |
| ------------------ | --------------------------- |
| `--base-url <url>` | Override the API server URL |

### `scarn pipelines build [file]`

Compile each `.ts` file in `.scarn/pipeline-builder/` that default-exports `definePipeline(...)` from `@scarn/sdk/pipelines` to `<key>.json` next to it, then validate the documents. Errors print the TypeScript location next to the JSON pointer. Steps used through `stepRef` are checked against the project's steps on the server, which needs you to be signed in.

```bash
scarn pipelines build
scarn pipelines build --check
```

| Flag                     | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `--check`                | Write nothing; fail if any JSON is missing or out of date (for CI) |
| `--project <owner/slug>` | The project whose steps resolve `stepRef` keys                     |
| `--base-url <url>`       | Override the API server URL                                        |

Never edit a built `<key>.json` by hand: change the `.ts` and build again.

The commands below take the project from `--project <owner/slug>` (defaults to `project` in `.scarn/scarn.jsonc`) and accept `--base-url <url>`.

### `scarn pipelines validate <file>`

Check a pipeline JSON document against the project's active step definitions, with the same validator the server runs on publish. Changes nothing.

```bash
scarn pipelines validate .scarn/pipeline-builder/bug-pipeline.json
```

### `scarn pipelines publish <file>`

Publish a pipeline JSON document as the pipeline's next active version. Creates the pipeline if its `key` is new. Publishing content identical to the latest version does nothing. A pipeline runs only once it's published.

```bash
scarn pipelines publish .scarn/pipeline-builder/bug-pipeline.json
```

| Flag            | Description                                                                                |
| --------------- | ------------------------------------------------------------------------------------------ |
| `--name <name>` | Display name when the pipeline is created (defaults to the document's title, then its key) |

### `scarn pipelines activate <key> <version>`

Make an earlier published version of a pipeline the active one, to roll back.

```bash
scarn pipelines activate bug-pipeline 2
```

### `scarn pipelines run <key>`

Queue a run of a pipeline against a work item. A worker ([`scarn work`](#scarn-work-project)) picks it up.

```bash
scarn pipelines run bug-pipeline --work-item-id <work-item-id>
```

| Flag                  | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `--work-item-id <id>` | Required. The work item to run the pipeline against  |
| `--version <n>`       | Run this published version instead of the active one |

---

## `scarn work [project]`

Run a worker that polls for and executes step jobs. A failing step doesn't stop it — the worker absorbs the
failure into its polling loop. To fix the pipeline, run `scarn pipelines design` again and tell the agent
what happened (see [The run offer](#the-run-offer)).

```bash
scarn work
scarn work <owner/slug>
```

| Flag                             | Alias | Default                   | Description                                                                                                               |
| -------------------------------- | ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--base-url <url>`               | —     | `https://app.scarn.io` | Override the API server URL                                                                                               |
| `--once`                         | —     | `false`                   | Poll once and wait for any claimed jobs to finish                                                                         |
| `--concurrency <n>`              | `-c`  | `1`                       | Max concurrently active jobs (env: `SCARN_WORK_CONCURRENCY`)                                                            |
| `--batch-size <n>`               | `-b`  | value of `--concurrency`  | Max tasks claimed per poll                                                                                                |
| `--lease-duration-seconds <n>`   | `-l`  | `30`                      | Seconds a claim lasts before the server can reclaim it; heartbeats extend it (env: `SCARN_WORK_LEASE_DURATION_SECONDS`) |
| `--poll-interval-ms <n>`         | `-p`  | `5000`                    | Milliseconds between polls while there is work to claim (env: `SCARN_WORK_POLL_INTERVAL_MS`)                            |
| `--max-poll-interval-ms <n>`     | —     | `60000`                   | Ceiling for the empty-poll backoff — see [Polling backoff](#polling-backoff) (env: `SCARN_WORK_MAX_POLL_INTERVAL_MS`)   |
| `--worker-id <id>`               | `-w`  | auto                      | Worker identifier used while claiming tasks                                                                               |
| `--work-item-id <id>`            | —     | —                         | Only process tasks for this work item ID                                                                                  |
| `--source-branch <branch>`       | —     | your current local branch | Branch checked out for the run's first step — see [Source branch](#source-branch)                                         |
| `--preserve-runtime-on-complete` | `-k`  | `false`                   | Keep runtime containers and workspace after the step (or, with `--dry-run`, after the report) for debugging               |
| `--dry-run`                      | —     | `false`                   | Rehearse a real step's environment (devcontainer + OpenCode + MCP servers) and report its health instead                  |
| `--step-id <id>`                 | —     | —                         | Dry run only: fetch this step definition's real MCP servers to test                                                       |
| `--global-only`                  | —     | `false`                   | Dry run only: skip step-specific MCP injection and test whatever is already configured                                    |
| `--pipeline-id <id>`             | —     | —                         | Dry run only: test this pipeline definition's first step — see [What a dry run tests](#what-a-dry-run-tests)              |

#### Polling backoff

Each empty poll doubles the interval, starting from `--poll-interval-ms`, up to `--max-poll-interval-ms`; it
resets as soon as work is claimed. Set the two equal for a fixed cadence.

#### Source branch

The default — your current local branch — must exist on `origin` and be in exact sync with it; push it first
if it isn't. A `--source-branch` override only needs to exist on `origin`. Later steps use their own work
branches — see [Base branch](/scarn/guides/workers/#base-branch).

#### What a dry run tests

`--pipeline-id` resolves a pipeline to its first step by position — unambiguous, unlike a step id — and wins
over `--step-id` and `--global-only`. With none of the three, a project with no step definitions yet is
tested as `--global-only`; otherwise an interactive terminal picks a step, and a non-interactive one errors
with the available step ids.

---

## `scarn runtime`

Utilities for managing the local execution environment.

### `scarn runtime cleanup-networks`

Remove unused Docker networks created by prior worker runs.

```bash
scarn runtime cleanup-networks
scarn runtime cleanup-networks --verbose
```

| Flag        | Description                                 |
| ----------- | ------------------------------------------- |
| `--verbose` | Print names of networks as they are removed |

---

## `scarn hello [name]`

Print a greeting.

```bash
scarn hello          # Hello, world!
scarn hello Alice    # Hello, Alice!
```

---

## `scarn report-bug`

File a bug report against the CLI. By default it opens a prefilled GitHub issue in your browser.

```bash
scarn report-bug
scarn report-bug --title "..." --description "..." --no-browser
```

| Flag                         | Default | Description                                                               |
| ---------------------------- | ------- | ------------------------------------------------------------------------- |
| `--title <text>`             | —       | Short summary of the bug                                                  |
| `--description <text>`       | —       | Detailed description                                                      |
| `--browser` / `--no-browser` | `true`  | Open the prefilled issue in a browser; `--no-browser` prints the URL only |

---

## `scarn telemetry`

Manage the CLI's onboarding-funnel observability reporting. See
[Observability](/scarn/reference/observability/) for what's collected and why, the
`status`/`disable`/`enable` subcommands, and the opt-out environment
variables.

---

## Exit codes

| Code  | Meaning                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------- |
| `0`   | Success                                                                                         |
| `1`   | Any failure; the message is on stderr                                                           |
| other | `pipelines design` and `pipelines push` pass through a non-zero exit from the TUI / push script |

### Failure codes

When `init`, `pipelines design`, or `pipelines push` fails, the failure is classified with one of these codes —
the `code` on the [`cli_command_failed`](/scarn/reference/observability/) event. The process still exits `1`
unless noted above.

| Code                             | Meaning                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `not_in_git_repo`                | No directory at or above the current one contains `.git`                                                |
| `no_origin_remote`               | The repository has no `origin` remote                                                                   |
| `not_signed_in_noninteractive`   | Not signed in, and the terminal can't run the device login                                              |
| `device_login_expired`           | The device-flow login expired or timed out before you approved it                                       |
| `device_login_denied`            | You denied the device-flow login in the browser                                                         |
| `device_login_failed`            | The device-flow login failed for another reason                                                         |
| `runtime_download_failed`        | The pinned OpenCode runtime could not be downloaded                                                     |
| `no_tty`                         | The command needs an interactive terminal                                                               |
| `opencode_login_failed`          | `opencode auth login` exited with an error, or closed without connecting a provider                     |
| `project_handoff_unresolved`     | `init` waited 15 minutes and no project for this repo was created                                       |
| `project_handoff_noninteractive` | No project for this repo, and no interactive terminal to hand off to a browser                          |
| `no_project_id`                  | `design` couldn't identify the project and none was entered                                             |
| `no_work_item`                   | No work item was chosen: the picker or the description prompt was cancelled or left blank               |
| `work_item_create_failed`        | The server rejected creating the work item you described                                                |
| `no_package_manager`             | Neither `bun` nor `npm` is on your `PATH` to install the builder's dependencies                         |
| `builder_install_failed`         | Installing the builder's dependencies failed                                                            |
| `run_queue_failed`               | The run offer could not queue the run                                                                   |
| `push_failed`                    | `pipelines push` failed: no builder directory, missing dependencies, or the push script exited non-zero |
| `build_failed`                   | `pipelines build` couldn't run: no builder directory, missing dependencies, or no runtime               |
| `build_check_failed`             | `pipelines build --check` found missing, out-of-date or invalid pipeline JSON                           |
| `designer_exited_nonzero`        | The designer TUI exited with a non-zero code                                                            |
| `invalid_usage`                  | The command line was rejected: unknown command or flag, or a missing argument                           |
| `unknown`                        | Anything not classified above                                                                           |

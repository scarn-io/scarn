---
title: CLI Reference
description: Complete reference for all scarn CLI commands and flags
---

## Platform binaries

The `@scarn/cli` npm package ships pre-compiled binaries for:

| Platform              | Binary                  |
| --------------------- | ----------------------- |
| macOS (Apple Silicon) | `scarn-darwin-arm64`    |
| macOS (Intel)         | `scarn-darwin-x64`      |
| Linux x64             | `scarn-linux-x64`       |
| Linux ARM64           | `scarn-linux-arm64`     |
| Windows x64           | `scarn-windows-x64.exe` |

---

## Global flags

These flags apply to every command:

| Flag                | Description                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `--env-file <path>` | Env file to load (default `.env` in the current directory); `.scarn.env` there is loaded too |
| `--verbose`, `-v`   | Show full diagnostic logs alongside the UI                                                   |
| `--help`            | Show help for the current command                                                            |
| `--version`         | Print the CLI version                                                                        |

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

| Failure            | Message                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Not `owner/slug`   | `"<ref>" is not a valid project. Expected "<owner>/<project-slug>", e.g. "acme/web-app".`              |
| No such project    | `No project <ref>. Check "project" in .scarn/scarn.jsonc — the owner may have renamed their username.` |
| You're not allowed | `You don't have permission to <action> <ref>.` — e.g. `push pipelines to`, `run work for`              |

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
    scaffolded by the builder-folder check) plus the `default.ts` [project automation](/scarn/guides/automations/) in place, typechecks, then runs
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
yes it queues a run of the first pipeline the project's `default` automation routes to against that work item and
hands it to this machine's [background worker](#scarn-worker), then prints "Queued" and returns.

| Situation                                                                                   | What happens                                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `default` routes to a pipeline, any devcontainer it needs present, health checks passed     | The confirm appears; accepting queues the run and hands it to the worker          |
| You decline                                                                                 | Prints `scarn work <owner/slug> --work-item-id <id>` and notes nothing is queued  |
| A step runs in your project's devcontainer and `.devcontainer/devcontainer.json` is missing | No offer: prints why, plus that same command                                      |
| No `default` project automation that routes to a pipeline                                   | No offer — the session never got as far as pushing one                            |
| A step's blocking health check fails the dry run                                            | No offer: prints why plus the same command; the next `design` session surfaces it |
| The session did not exit cleanly                                                            | No offer. A non-zero designer exit code still passes through                      |

After declining, start a run from the work item in the dashboard and that command picks it up.

The hand-off starts the worker if it isn't running. If the project isn't on the worker yet, it's added with no
work-item filter; if it is, its settings are left alone, with a warning when its `--work-item-id` filter would
keep the worker from picking up this run. The offer also says where a failed run goes: back to
`scarn pipelines design`, to tell the agent what happened. The worker runs the steps after `design` has
returned, so a failing step or a devcontainer that won't build only shows in `scarn worker status` and
`scarn worker logs`. It keeps the project until you [remove it](#scarn-worker-remove-project), because later
steps queue as earlier ones advance.

#### Edit sessions

When definitions already exist, the agent states a change-size verdict and gets your confirmation before it
edits a file: **tweak** an existing pipeline, add a **route** in `default.ts`, or create a
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

Scaffold `.scarn/pipeline-builder/` with a starter `package.json`, `tsconfig.json`, the [default pipeline](/scarn/getting-started/concepts/#default-pipeline) (`bug-pipeline.ts` and its built `bug-pipeline.json`), and a `default.ts` [project automation](/scarn/guides/automations/) that routes every ready work item to it, then edit them by hand. Use `scarn pipelines design` unless you specifically want to author everything yourself.

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

| Check                      | If missing                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.scarn/pipeline-builder/` | Scaffolds it at the project root, the same starter files as [`pipelines init`](#scarn-pipelines-init)                                                     |
| Dependencies               | **Not** installed for you. It stops and prints the command to run inside that directory (`bun install` / `npm install` / `pnpm install` / `yarn install`) |

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

| File                  | Description                                                                   |
| --------------------- | ----------------------------------------------------------------------------- |
| `package.json`        | Declares `@scarn/sdk` and `zod` dependencies (only on first pull)             |
| `tsconfig.json`       | TypeScript config scoped to the pipeline-builder package (only on first pull) |
| `.gitignore`          | Ignores `node_modules/`, lockfiles, and `push.ts` (only on first pull)        |
| `steps.ts`            | One `defineStep()` export per step definition (latest version of each key)    |
| `<pipeline-key>.json` | Each pipeline's active version, as a JSON document                            |

After pulling, run `npm install` or `bun install` inside `.scarn/pipeline-builder/` to install dependencies. Edit the files, run `npm run typecheck` there to validate them, then [`scarn pipelines push`](#scarn-pipelines-push-project). The files are source code — commit them (see [`pipelines init`](#scarn-pipelines-init) for what the `.gitignore` leaves out).

### `scarn pipelines push [project]`

Push `.scarn/pipeline-builder/` to the server, in order:

1. Upsert every step definition.
2. Publish every built `<key>.json` pipeline document, as [`publish`](#scarn-pipelines-publish-file) would. A new key creates the pipeline; a document identical to its latest version publishes nothing. Run [`build`](#scarn-pipelines-build-file) first, or push publishes stale JSON.
3. Publish every built automation document (`<key>.json` with `"kind": "automation"`), work-item automations before project ones, since a project automation can only attach automations that exist. A new automation starts disabled; turn it on with [`scarn automations enable`](#scarn-automations). A document identical to its latest version publishes nothing.

Every file is read and the steps are validated before the first write. Other `.json` files (`package.json`, `tsconfig.json`, any without `nodes` or `"kind": "automation"`) are skipped. Absent files are ignored; they do not clear server configuration, and deleting an automation's source doesn't unpublish it.

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

### `scarn pipelines show <pipeline>`

Show a published pipeline document by key or id: the version and whether it is active, the start route, then every node with its kind, the step definition version it pins, its limits and its edges (routes, `otherwise` and `catch`). It ends with `scarn runs list --pipeline <key>`. `--json` prints the version as stored (`version`, `definition`, `steps`, …) and nothing else on stdout.

```bash
scarn pipelines show bug-pipeline
scarn pipelines show bug-pipeline --version 2 --json
```

| Flag               | Default | Description                                                                  |
| ------------------ | ------- | ---------------------------------------------------------------------------- |
| `--project <ref>`  | config  | The project, as `owner/slug` (defaults to `project` in `.scarn/scarn.jsonc`) |
| `--version <n>`    | active  | Show this published version instead of the active one                        |
| `--json`           | `false` | Print the pipeline version as one JSON document                              |
| `--base-url <url>` | —       | Override the API server URL                                                  |

---

## `scarn automations`

Turn project automations on and off, and attach work-item automations to work items. Automations are published by [`scarn pipelines push`](#scarn-pipelines-push-project). Every subcommand accepts `--base-url <url>`; `enable` and `disable` take the project from `--project <owner/slug>` (defaults to `project` in `.scarn/scarn.jsonc`).

### `scarn automations enable <key>` / `disable <key>`

Turn a project automation on or off. A work-item automation can't be enabled; attach it to a work item instead.

```bash
scarn automations enable attach-wayfinder
scarn automations disable attach-wayfinder
```

### `scarn automations attach <workItem> <key>` / `detach <workItem> <key>`

Attach a work-item automation to a work item, or detach it. `<workItem>` is the work item's id, or its ticket URL; a URL is looked up in the project from `--project`.

```bash
scarn automations attach 0196a000-0000-7000-8000-0000000000aa wayfinder
scarn automations detach https://github.com/acme/app/issues/7 wayfinder
```

---

## Debugging

The commands from here to `scarn work-items` let you follow a problem from a work item to the line of log that explains it, from a terminal or from an agent's shell. A typical path:

```bash
scarn runs list --work-item acme/app#7 --status failed
scarn runs thread 0196a000-0000-7000-8000-0000000000bb --step investigate
scarn tasks view 0196a000-0000-7000-8000-0000000000c1
scarn logs 0196a000-0000-7000-8000-0000000000e1 --grep "error|failed"
scarn artifacts list 0196a000-0000-7000-8000-0000000000e1
scarn runs message 0196a000-0000-7000-8000-0000000000bb --step investigate --body "Check the retry logic first."
```

- Text output ends with `→ scarn …` lines: the next command to run, with its ids filled in.
- `--json` on any read prints exactly one JSON document on stdout and nothing else.
- `rerun` and `cancel` need `--yes` when there is no terminal to confirm in; otherwise they fail with `confirmation_required`.
- A failed action is classified as `action_not_found`, `action_forbidden`, `action_conflict`, `action_rejected` or `action_failed` — see [Failure codes](#failure-codes).

---

## `scarn runs`

List pipeline runs, read their steps' message threads, and rerun, message or cancel them. Every subcommand prints text by default and ends with the next command to run; `--json` prints the API response as one JSON document and nothing else on stdout.

The actions (`rerun`, `message`, `cancel`) are explicit verbs, never flags on a read. Each prints what it did, with the resulting ids, and the read command to follow up with. `rerun` and `cancel` ask for confirmation on a terminal and need `--yes` when there is none (they fail with `confirmation_required` otherwise); `message` doesn't ask.

### `scarn runs list`

List the project's pipeline runs, newest first. Each entry shows a status glyph, the short and full id, the pipeline key, the work item, the steps the run is at, and its timing and error. The list ends with `scarn runs thread` for the newest run, at its first open step.

```bash
scarn runs list
scarn runs list --work-item acme/app#7 --status failed
scarn runs list --pipeline ship-it --limit 10 --json
```

| Flag                   | Default | Description                                                                  |
| ---------------------- | ------- | ---------------------------------------------------------------------------- |
| `--project <ref>`      | config  | The project, as `owner/slug` (defaults to `project` in `.scarn/scarn.jsonc`) |
| `--work-item <ref>`    | —       | Only this work item's runs: its id, tracker URL, or platform key             |
| `--pipeline <key\|id>` | —       | Only runs of this pipeline                                                   |
| `--status <status>`    | —       | `queued`, `running`, `waiting`, `succeeded`, `failed` or `cancelled`         |
| `--limit <n>`          | `25`    | How many runs to show, at most `100`                                         |
| `--json`               | `false` | Print the API page (`items`, `pagination`)                                   |
| `--base-url <url>`     | —       | Override the API server URL                                                  |

### `scarn runs thread <runId>`

Show the messages sent to a step's Task runs, oldest Task run first, with each one's status and whether it restored the previous Task run's session. Each visit to a step is an attempt, numbered from 1 oldest first; without `--attempt` the latest current visit is shown.

```bash
scarn runs thread 0196a000-0000-7000-8000-0000000000bb --step investigate
scarn runs thread 0196a000-0000-7000-8000-0000000000bb --step investigate --attempt 1 --json
```

| Flag               | Default | Description                                        |
| ------------------ | ------- | -------------------------------------------------- |
| `--step <key>`     | —       | Required. The step whose thread to show            |
| `--attempt <n>`    | latest  | Which visit to the step, `1` for the first         |
| `--json`           | `false` | Print the API thread (`visitId`, `nodeId`, `runs`) |
| `--base-url <url>` | —       | Override the API server URL                        |

### `scarn runs rerun <runId>`

Rerun a step of a pipeline run: `--step` picks the step (and `--attempt` the visit, defaulting to the latest current one), `--failed` picks every failed step visit. The confirmation lists every visit that will be rerun. Rerunning a visit supersedes every visit downstream of it, so with `--failed` a visit an earlier rerun already superseded is skipped and reported. Prints each new visit and ends with `scarn runs thread` for the first rerun step.

```bash
scarn runs rerun 0196a000-0000-7000-8000-0000000000bb --step investigate
scarn runs rerun 0196a000-0000-7000-8000-0000000000bb --failed --yes
```

| Flag               | Default | Description                                                |
| ------------------ | ------- | ---------------------------------------------------------- |
| `--step <key>`     | —       | The step to rerun (exactly one of `--step` and `--failed`) |
| `--attempt <n>`    | latest  | With `--step`: which visit to rerun, `1` for the first     |
| `--failed`         | `false` | Rerun every failed step of the run                         |
| `--yes`, `-y`      | `false` | Skip the confirmation (required when not on a terminal)    |
| `--json`           | `false` | Print the pipeline run as returned by the last rerun       |
| `--base-url <url>` | —       | Override the API server URL                                |

### `scarn runs message <runId>`

Send a message to a step. The step's visit reruns with a new Task that carries the message; code steps don't accept messages. Doesn't ask for confirmation. Prints the message id and the new Task, and ends with `scarn runs thread` and `scarn tasks view`.

```bash
scarn runs message 0196a000-0000-7000-8000-0000000000bb --step investigate --body "Check the retry logic first."
scarn runs message 0196a000-0000-7000-8000-0000000000bb --step investigate --body @feedback.md
git diff | scarn runs message 0196a000-0000-7000-8000-0000000000bb --step review --body -
```

| Flag                      | Default | Description                                                  |
| ------------------------- | ------- | ------------------------------------------------------------ |
| `--step <key>`            | —       | Required. The step to message                                |
| `--attempt <n>`           | latest  | Which visit to the step, `1` for the first                   |
| `--body <text\|@file\|->` | —       | Required. The message, `@path` to read a file, `-` for stdin |
| `--json`                  | `false` | Print the API response (`message`, `pipelineExecution`)      |
| `--base-url <url>`        | —       | Override the API server URL                                  |

### `scarn runs cancel <runId>`

Cancel a pipeline run and its open Tasks, after confirming. Ends with `scarn runs list --work-item` for the run's work item.

```bash
scarn runs cancel 0196a000-0000-7000-8000-0000000000bb --yes
```

| Flag               | Default | Description                                             |
| ------------------ | ------- | ------------------------------------------------------- |
| `--yes`, `-y`      | `false` | Skip the confirmation (required when not on a terminal) |
| `--json`           | `false` | Print the cancelled pipeline run                        |
| `--base-url <url>` | —       | Override the API server URL                             |

---

## `scarn inbox`

Show what waits on you in a project: the inbox counts, then open questions and decisions on pipeline runs, Tasks waiting on you, failed Tasks you started, work items with comment drafts to approve, ready work items never given a Task, and the latest notifications. Each entry ends with its next command: a question with `scarn work-items view` and `scarn work-items answer`, a decision with `scarn runs list --work-item`, a Task with `scarn runs thread` or `scarn tasks view`, and a draft with `scarn work-items comments <ref> --drafts`. A list that fails to load shows one `(unavailable: <reason>)` line instead of failing the command.

```bash
scarn inbox
scarn inbox --project acme/app --json
```

| Flag               | Default | Description                                                                                               |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------- |
| `--project <ref>`  | config  | The project, as `owner/slug` (defaults to `project` in `.scarn/scarn.jsonc`)                              |
| `--limit <n>`      | `20`    | How many Tasks and draft work items to list, at most `100`                                                |
| `--json`           | `false` | Print `summary`, `waits`, `tasksWaitingOnMe`, `failedTasks`, `drafts` and `notifications` as one document |
| `--base-url <url>` | —       | Override the API server URL                                                                               |

---

## `scarn tasks`

List Tasks, read one with its runs, and retry or cancel one. Every subcommand prints text by default and ends with the next command to run; `cancel` asks for confirmation on a terminal and needs `--yes` when there is none; `--json` prints one JSON document and nothing else on stdout.

### `scarn tasks list`

List the project's Tasks, newest first. Each entry shows a status glyph, the short and full id, the kind, where its instructions came from, the work item, the latest run number and duration, the pipeline run and step that created it, and its latest error, message or log line. The list ends with `scarn tasks view` for the newest Task.

```bash
scarn tasks list
scarn tasks list --work-item acme/app#7 --status failed --status waiting_for_person
scarn tasks list --kind code --limit 10 --json
```

| Flag                | Default | Description                                                                                                                                           |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--project <ref>`   | config  | The project, as `owner/slug` (defaults to `project` in `.scarn/scarn.jsonc`)                                                                          |
| `--work-item <ref>` | —       | Only this work item's Tasks: its id, tracker URL, or platform key                                                                                     |
| `--status <status>` | —       | Repeat for several: `waiting_for_concurrency_slot`, `waiting_for_work`, `queued`, `running`, `waiting_for_person`, `succeeded`, `failed`, `cancelled` |
| `--kind <kind>`     | —       | `agent` or `code`                                                                                                                                     |
| `--limit <n>`       | `25`    | How many Tasks to show, at most `200`                                                                                                                 |
| `--json`            | `false` | Print the API page (`tasks`, `nextCursor`, `counts`)                                                                                                  |
| `--base-url <url>`  | —       | Override the API server URL                                                                                                                           |

### `scarn tasks view <taskId>`

Show a Task: where its instructions came from (step definition key and version, or the prompt), its input, its config, its result or error, its runs oldest first with each one's reason (`initial`, `retry` or `continuation`), and the earlier Tasks of the same step, followed back through `previousTaskId`. It ends with `scarn logs` and `scarn task-runs view` for the latest run, and `scarn runs thread` when a pipeline run created the Task.

```bash
scarn tasks view 0196a000-0000-7000-8000-0000000000c1
scarn tasks view 0196a000-0000-7000-8000-0000000000c1 --json
```

| Flag               | Default | Description                                                |
| ------------------ | ------- | ---------------------------------------------------------- |
| `--json`           | `false` | Print `{ task, runs, previousTasks, previousTasksCutOff }` |
| `--base-url <url>` | —       | Override the API server URL                                |

### `scarn tasks retry <taskId>`

Retry a failed or cancelled standalone Task in place. Doesn't ask for confirmation. It sends the id of the Task's latest run, so a retry that races another one fails with `action_conflict` instead of starting twice. A Task a pipeline step owns can't be retried this way: the error names the `scarn runs rerun` command to use instead. Prints the new Task run and ends with `scarn tasks view` and `scarn logs --follow` for it.

```bash
scarn tasks retry 0196a000-0000-7000-8000-0000000000c1
```

| Flag               | Default | Description                   |
| ------------------ | ------- | ----------------------------- |
| `--json`           | `false` | Print `{ taskId, taskRunId }` |
| `--base-url <url>` | —       | Override the API server URL   |

### `scarn tasks cancel <taskId>`

Cancel an agent Task, after confirming. Cancelling a Task a pipeline step owns cancels its whole pipeline run, and the confirmation says so. Ends with `scarn tasks view`.

```bash
scarn tasks cancel 0196a000-0000-7000-8000-0000000000c1 --yes
```

| Flag               | Default | Description                                             |
| ------------------ | ------- | ------------------------------------------------------- |
| `--yes`, `-y`      | `false` | Skip the confirmation (required when not on a terminal) |
| `--json`           | `false` | Print `{ taskId }`                                      |
| `--base-url <url>` | —       | Override the API server URL                             |

---

## `scarn task-runs`

Read a Task run.

### `scarn task-runs view <taskRunId>`

Show a Task run: its status and reason, the worker that claimed it with its last heartbeat and lease expiry, its timings and deadline, its branches, its result or error, and the artifacts it recorded. It ends with `scarn logs` and `scarn artifacts list` for the run, and `scarn tasks view` for its Task.

```bash
scarn task-runs view 0196a000-0000-7000-8000-0000000000e1
scarn task-runs view 0196a000-0000-7000-8000-0000000000e1 --json
```

| Flag               | Default | Description                 |
| ------------------ | ------- | --------------------------- |
| `--json`           | `false` | Print `{ run, artifacts }`  |
| `--base-url <url>` | —       | Override the API server URL |

---

## `scarn logs`

### `scarn logs <id>`

Show a Task run's log: the worker, AI server and conversation streams, rendered as text. Pass a Task run id, or a Task id for its latest run. A finished run's log comes from its archive; a running one's from the live feed.

The full log is always saved to `~/.scarn/task-logs/<taskRunId>-<stream|all>.log`. Without a filter, stdout shows the last ~20,000 characters and the saved path. `--grep`, `--tail` and `--since-line` select lines instead and print each one with its line number in the saved file. The output ends with `scarn artifacts list` and `scarn task-runs view` for the run.

```bash
scarn logs 0196a000-0000-7000-8000-0000000000e1
scarn logs 0196a000-0000-7000-8000-0000000000c1 --run 1 --stream conversation
scarn logs 0196a000-0000-7000-8000-0000000000e1 --grep "error|failed" --tail 20
scarn logs 0196a000-0000-7000-8000-0000000000e1 --since-line 400 --json
scarn logs 0196a000-0000-7000-8000-0000000000e1 --follow
```

| Flag                | Default | Description                                                                                                                                  |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--run <n>`         | latest  | With a Task id: show run number `n`                                                                                                          |
| `--stream <stream>` | all     | Only `worker`, `ai-server` or `conversation`                                                                                                 |
| `--grep <regex>`    | —       | Only lines matching the regular expression                                                                                                   |
| `--tail <n>`        | —       | Only the last `n` lines (after `--since-line` and `--grep`)                                                                                  |
| `--since-line <n>`  | —       | Only lines after line `n` of the saved log                                                                                                   |
| `--follow`          | `false` | Keep printing new lines every 2 seconds until the run finishes and its log is archived. Not with `--json`, `--grep` or `--tail`              |
| `--json`            | `false` | Print `{ taskRunId, taskId, runNumber, status, source, stream, savedTo, saveError, totalLines, lines }`, where each line is `{ line, text }` |
| `--base-url <url>`  | —       | Override the API server URL                                                                                                                  |

---

## `scarn artifacts`

The files a Task run recorded: screenshots, Playwright traces, videos and other outputs.

### `scarn artifacts list <taskRunId>`

List a Task run's artifacts with their id, path, kind, content type, size and time. `--failures` adds the uploads that failed, with their error. The list ends with `scarn artifacts download` for the first artifact.

```bash
scarn artifacts list 0196a000-0000-7000-8000-0000000000e1
scarn artifacts list 0196a000-0000-7000-8000-0000000000e1 --failures --json
```

| Flag               | Default | Description                                 |
| ------------------ | ------- | ------------------------------------------- |
| `--failures`       | `false` | Also list the artifacts whose upload failed |
| `--json`           | `false` | Print `{ taskRunId, artifacts, failures? }` |
| `--base-url <url>` | —       | Override the API server URL                 |

### `scarn artifacts download <taskRunId> <artifact>`

Download an artifact. `<artifact>` is its id, its path, or its file name when only one artifact has that name. The file is saved to `--out`, or `./<file name>` by default, and the command prints the saved path. An existing file is never overwritten.

```bash
scarn artifacts download 0196a000-0000-7000-8000-0000000000e1 0196a000-0000-7000-8000-0000000000f1
scarn artifacts download 0196a000-0000-7000-8000-0000000000e1 shots/home.png --out /tmp/home.png
```

| Flag               | Default         | Description                 |
| ------------------ | --------------- | --------------------------- |
| `--out <path>`     | `./<file name>` | Where to save the file      |
| `--base-url <url>` | —               | Override the API server URL |

---

## `scarn work-items`

Read work items, their comments and their activity, comment on them, and answer the questions pipeline runs ask on them. `comment` and `answer` don't ask for confirmation. Every subcommand prints text by default and ends with the next command to run. `--json` prints the API response as one JSON document and nothing else on stdout. Every subcommand accepts `--project <owner/slug>` (defaults to `project` in `.scarn/scarn.jsonc`) and `--base-url <url>`.

`<ref>` names a work item by its id, its tracker URL, or its platform key (`owner/repo#123` for GitHub, `PROJ-123` for Jira). An id needs no project; a URL or key is looked up in the project.

### `scarn work-items list`

List the project's work items, most recently updated first. Each entry shows the latest run's status, the short and full id, the platform key, the title, the state, the assignee and the labels.

```bash
scarn work-items list
scarn work-items list --status failed --label bug --label flaky
scarn work-items list --assignee me --updated-after 7d --json
```

| Flag                     | Default | Description                                                                |
| ------------------------ | ------- | -------------------------------------------------------------------------- |
| `--status <status>`      | —       | Latest run status: `active`, `waiting`, `succeeded`, `failed`, `cancelled` |
| `--label <label>`        | —       | Only items carrying this label. Repeat to require several                  |
| `--platform <platform>`  | —       | Tracker platform: `github`, `jira`, `linear`, `scarn`, …                   |
| `--assignee <who>`       | —       | `me`, `none`, or a user id                                                 |
| `--updated-after <when>` | —       | Updated within `<N>h` or `<N>d`, or since `YYYY-MM-DD`                     |
| `--search <text>`        | —       | Search titles, descriptions and keys                                       |
| `--limit <n>`            | `25`    | How many items to show, up to 100                                          |
| `--json`                 | `false` | Print the API's `{ items, pagination }` body                               |

### `scarn work-items view <ref>`

Show one work item: its fields, state, labels, parent and description, then its blocks, children, open questions, and its latest 5 pipeline runs and Tasks. These sections are fetched in parallel. A section that fails to load prints `(unavailable: <reason>)` and the rest still render.

```bash
scarn work-items view acme/app#7
scarn work-items view https://github.com/acme/app/issues/7
scarn work-items view 0196a000-0000-7000-8000-0000000000aa --json
```

| Flag     | Default | Description                                                                                                                                                                     |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json` | `false` | Print `workItem`, plus `blocks`, `children`, `questions`, `runs` and `tasks`. Each section is `{ "status": "loaded", "data": … }` or `{ "status": "unavailable", "reason": … }` |

### `scarn work-items comments <ref>`

Show a work item's comments, oldest first, with each author, timestamp and id. `--drafts` shows the agent-written comments that are waiting for someone to approve them instead.

```bash
scarn work-items comments acme/app#7
scarn work-items comments acme/app#7 --drafts
```

| Flag          | Default | Description                                     |
| ------------- | ------- | ----------------------------------------------- |
| `--drafts`    | `false` | Show pending comment drafts instead of comments |
| `--limit <n>` | `50`    | Show only the latest `n`                        |
| `--json`      | `false` | Print the (limited) array from the API          |

### `scarn work-items activity <ref>`

Show a work item's activity log, oldest first: one line per entry with its timestamp, kind and message.

```bash
scarn work-items activity acme/app#7 --limit 20
```

| Flag          | Default | Description                            |
| ------------- | ------- | -------------------------------------- |
| `--limit <n>` | `50`    | Show only the latest `n`               |
| `--json`      | `false` | Print the (limited) array from the API |

### `scarn work-items comment <ref>`

Add a comment to a work item. Doesn't ask for confirmation. Prints the comment id and ends with `scarn work-items comments`.

```bash
scarn work-items comment acme/app#7 --body "Reproduced on main."
scarn work-items comment acme/app#7 --body @notes.md
```

| Flag                      | Default | Description                                                  |
| ------------------------- | ------- | ------------------------------------------------------------ |
| `--body <text\|@file\|->` | —       | Required. The comment, `@path` to read a file, `-` for stdin |
| `--json`                  | `false` | Print the created comment                                    |

### `scarn work-items answer <ref> <questionId>`

Answer a pipeline run's open question on a work item; the step waiting on it resumes. The answer is saved as a reply under the question's comment. `scarn inbox` and `scarn work-items view` show the question ids. A question that is already answered fails with `action_conflict` and nothing is saved. Doesn't ask for confirmation. Ends with `scarn work-items comments` and `scarn runs list --work-item`.

```bash
scarn work-items answer acme/app#7 0196a000-0000-7000-8000-0000000000f1 --body "Use Postgres."
```

| Flag                      | Default | Description                                                 |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `--body <text\|@file\|->` | —       | Required. The answer, `@path` to read a file, `-` for stdin |
| `--json`                  | `false` | Print the answer comment                                    |

---

## `scarn work [project]`

Start this machine's background worker if it isn't running, add the project in the current checkout to it,
and return. The worker keeps claiming and running the project's steps after the command exits; a failing step
doesn't stop it. Follow it with `scarn worker status` and `scarn worker logs -f`. To fix the pipeline, run
`scarn pipelines design` again and tell the agent what happened (see [The run offer](#the-run-offer)).

Running it again for a project already on the worker updates that project's settings. Run it from inside the
project's git repository: the worker remembers the repository root and the source branch, and saves the
project's limit, `--work-item-id` filter and `-k`, so the project comes back when the worker restarts. Only
`--work-item-id` filters what the worker claims. With `--dry-run` the command runs in the foreground instead and
only reports on the environment; nothing is added to the worker. To claim once in this terminal and exit, use
[`scarn worker start --foreground --once`](#scarn-worker-start-project).

```bash
scarn work
scarn work <owner/slug>
scarn work --dry-run
```

| Flag                             | Alias | Default                   | Description                                                                                                  |
| -------------------------------- | ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--base-url <url>`               | —     | `https://app.scarn.io`    | Override the API server URL                                                                                  |
| `--concurrency <n>`              | `-c`  | no project limit          | Max runs of this project at a time, within the worker's machine-wide limit                                   |
| `--work-item-id <id>`            | —     | —                         | Only process tasks for this work item ID                                                                     |
| `--source-branch <branch>`       | —     | your current local branch | Branch checked out for the run's first step — see [Source branch](#source-branch)                            |
| `--preserve-runtime-on-complete` | `-k`  | `false`                   | Keep runtime containers and workspace after each run (or, with `--dry-run`, after the report) for debugging  |
| `--dry-run`                      | —     | `false`                   | Rehearse a real step's environment (devcontainer + OpenCode + MCP servers) and report its health instead     |
| `--step-id <id>`                 | —     | —                         | Dry run only: fetch this step definition's real MCP servers to test                                          |
| `--global-only`                  | —     | `false`                   | Dry run only: skip step-specific MCP injection and test whatever is already configured                       |
| `--pipeline-id <id>`             | —     | —                         | Dry run only: test this pipeline definition's first step — see [What a dry run tests](#what-a-dry-run-tests) |

The project's `.scarn/.env` is read again for every claim, so edits to it apply to the next run without a
restart. The worker's claim loop is tuned with environment variables set when the worker starts:
`SCARN_WORK_LEASE_DURATION_SECONDS` (default `30`), `SCARN_WORK_POLL_INTERVAL_MS` (`5000`),
`SCARN_WORK_MAX_POLL_INTERVAL_MS` (`600000`) and `SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS` (`3600000`).

#### Polling backoff

Each empty poll doubles the interval, starting from `SCARN_WORK_POLL_INTERVAL_MS`, up to
`SCARN_WORK_MAX_POLL_INTERVAL_MS`. The interval resets as soon as work is claimed. Set the two equal for a
fixed cadence. An idle worker can take up to `SCARN_WORK_MAX_POLL_INTERVAL_MS` to notice new work. The
10-minute default is deliberately longer than the database's 5-minute idle-suspend window, so idle workers
let the database sleep.

While the [push wake-up](/scarn/guides/workers/#push-wake-up) connection is up, new work wakes the worker
straight away, so the poll is only a safety net. An empty poll skips the doubling and sleeps for the larger of
`SCARN_WORK_MAX_POLL_INTERVAL_MS` and `SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS` (60 minutes by default).
While work is being claimed, the worker still polls every `SCARN_WORK_POLL_INTERVAL_MS`. If the connection
drops, the backoff returns to `SCARN_WORK_MAX_POLL_INTERVAL_MS` at once, and a longer sleep already under way
is cut short to match. Each (re)connect also triggers an immediate poll.

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

## `scarn worker`

Manage this machine's background worker: one long-running process that claims and runs Task runs for every
project added to it, within one machine-wide limit. See [Workers](/scarn/guides/workers/) for how it behaves.

Each CLI instance has its own worker: `scarn` and a linked `scarn-dev` never share one. Set
`SCARN_WORKER_INSTANCE=<name>` (lowercase letters, digits and dashes) to run a separate one, for example for
another server. An instance's files are in `~/.scarn/workers/<instance>/`, and its saved settings in
`~/.scarn/db.sqlite`.

Commands that talk to a running worker check that it runs the same version as the CLI and fail with
`worker_version_mismatch` otherwise; run `scarn worker stop && scarn worker start` after upgrading. `start`,
`stop` and `logs` skip the check. A command that needs a running worker exits `3` when there is none.

### `scarn worker start [project]`

Start this instance's worker in the background and return. If it's already running, it says so. The worker
restores every project saved for the instance; a project that can't be restored keeps its settings and shows
as an error in `status`. Its stdout and stderr go to `worker.stdio.log`, next to the worker log.

With `--foreground` the worker runs in this terminal instead: the first Ctrl-C lets running runs finish, the
second aborts them. Only one worker runs per instance; a second fails with `worker_already_running`.

With `--foreground --once` it doesn't start a worker at all: it claims once for one project from the current
checkout, waits for the runs it claimed and exits. Nothing is saved. If this instance's worker is running, the
runs count toward its machine-wide limit.

```bash
scarn worker start
scarn worker start --max-concurrency 4
scarn worker start --foreground
scarn worker start --foreground --once acme/app --work-item-id 0196a000-0000-7000-8000-0000000000aa -k
```

| Flag                             | Alias | Default                            | Description                                                                                               |
| -------------------------------- | ----- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--foreground`                   | —     | `false`                            | Run the worker in this terminal instead of in the background                                              |
| `--max-concurrency <n>`          | —     | saved, else `1`                    | Machine-wide limit on runs at a time across every project; saved for the instance                         |
| `--base-url <url>`               | —     | `https://app.scarn.io`             | The server the instance works for, bound on its first start; another one fails `worker_base_url_mismatch` |
| `--once`                         | —     | `false`                            | With `--foreground`: claim once for one project and exit                                                  |
| `--concurrency <n>`              | `-c`  | `SCARN_WORK_CONCURRENCY`, else `1` | With `--once`: max runs at a time                                                                         |
| `--work-item-id <id>`            | —     | —                                  | With `--once`: only process tasks for this work item ID                                                   |
| `--source-branch <branch>`       | —     | your current local branch          | With `--once`: branch checked out for the run's first step — see [Source branch](#source-branch)          |
| `--preserve-runtime-on-complete` | `-k`  | `false`                            | With `--once`: keep runtime containers and workspace after each run                                       |

`[project]` only applies with `--once`; it defaults to `project` in `.scarn/scarn.jsonc`. With no saved limit,
`SCARN_WORK_CONCURRENCY` sets the first one.

### `scarn worker stop`

Stop this instance's worker and wait for it to exit. By default the worker stops claiming and lets its running
runs finish; the command lists them while it waits. `--force` aborts them instead, and each one is reported
`failed` with the code `WORKER_STOPPED`. Pressing Ctrl-C only stops the waiting: the worker keeps draining.
Saved settings are kept, so the next `start` restores every project.

```bash
scarn worker stop
scarn worker stop --force
```

| Flag      | Default | Description                                           |
| --------- | ------- | ----------------------------------------------------- |
| `--force` | `false` | Abort the running runs instead of letting them finish |

### `scarn worker status`

Show the worker (version, pid, server and machine-wide limit), each project with its state, settings and
errors, the runs in progress and the most recent finished runs. A project in `error` (its repository is
missing, the project is unavailable, or its login failed or now belongs to another user) claims nothing new
until it recovers; its running runs carry on, and it retries by itself. Exits `3` when no worker is running.

```bash
scarn worker status
scarn worker status --json
```

| Flag                | Default | Description                                               |
| ------------------- | ------- | --------------------------------------------------------- |
| `--json`            | `false` | Print the worker's health and status as one JSON document |
| `--recent-runs <n>` | `20`    | How many recent runs to show                              |

### `scarn worker logs [project]`

Show the worker log, `~/.scarn/workers/<instance>/worker.log`. It's read straight from disk, so it works when
the worker isn't running. The worker rotates it by size and by day. Lines are pretty-printed in a terminal and
printed as raw JSON lines when piped. `[project]` is a project ID, or the `owner/slug` of a project added to
the worker.

```bash
scarn worker logs
scarn worker logs acme/app -f
scarn worker logs --run 0196a000-0000-7000-8000-0000000000d1
```

| Flag         | Alias | Default | Description                                       |
| ------------ | ----- | ------- | ------------------------------------------------- |
| `--run <id>` | —     | —       | Only lines for this Task run ID                   |
| `--follow`   | `-f`  | `false` | Keep printing lines as they are written           |
| `--tail <n>` | —     | `200`   | How many of the last matching lines to show first |

For one run's own output (the agent's conversation and its devcontainer), use [`scarn logs`](#scarn-logs-id).

### `scarn worker config`

Change the running worker's settings. The worker saves them for the instance, so they also apply after a
restart. Lowering the limit only affects new claims: runs already going finish.

```bash
scarn worker config --max-concurrency 2
```

| Flag                    | Description                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `--max-concurrency <n>` | Machine-wide limit on runs at a time across every project (saved) |

### `scarn worker add [project]`

Add the project in the current checkout to the running worker, or update its settings. `scarn work` does
the same after starting the worker. It takes `scarn work`'s flags except the dry-run ones. A project on another
server than the worker's is refused (`worker_base_url_mismatch`).

```bash
scarn worker add
scarn worker add acme/app -c 2
```

### `scarn worker remove <project>`

Remove a project, by `owner/slug` or ID, from the running worker. Its runs already in progress finish, and the
command names them.

```bash
scarn worker remove acme/app
```

### `scarn worker cancel <taskRunId>`

Cancel a Task run's Task on the server, then stop the run if this machine's worker is running it. A run on
another worker stops on that worker's next heartbeat. The server cancel happens even with no local worker. A
code Task can't be stopped (`action_rejected`). Cancelling a Task that a pipeline step owns cancels the whole
pipeline run, so the command asks first; `--yes` skips the question.

```bash
scarn worker cancel 0196a000-0000-7000-8000-0000000000d1
scarn worker cancel 0196a000-0000-7000-8000-0000000000d1 --yes
```

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
| `3`   | `worker status`, `config`, `add` and `remove` found no running worker (`worker_not_running`)    |
| other | `pipelines design` and `pipelines push` pass through a non-zero exit from the TUI / push script |

### Failure codes

When a command fails, the failure is classified with one of these codes —
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
| `automation_request_failed`      | The server rejected an `automations` command, e.g. enabling a work-item automation                      |
| `build_failed`                   | `pipelines build` couldn't run: no builder directory, missing dependencies, or no runtime               |
| `build_check_failed`             | `pipelines build --check` found missing, out-of-date or invalid pipeline JSON                           |
| `designer_exited_nonzero`        | The designer TUI exited with a non-zero code                                                            |
| `invalid_usage`                  | The command line was rejected: unknown command or flag, or a missing argument                           |
| `confirmation_required`          | A command that changes something needs confirmation, and there is no terminal to ask in: pass `--yes`   |
| `work_item_lookup_failed`        | The server rejected looking up a work item by id, URL or platform key                                   |
| `body_unreadable`                | The file named by `--body @path` could not be read                                                      |
| `action_not_found`               | An action's target doesn't exist: the pipeline run, step, attempt, Task or question                     |
| `action_forbidden`               | The server refused an action because you lack the permission it needs                                   |
| `action_conflict`                | An action raced a change: a stale Task retry, or a question that is no longer open                      |
| `action_rejected`                | The server rejected an action in the target's current state, e.g. retrying a pipeline step's Task       |
| `action_failed`                  | An action failed for another reason; the server's message is on stderr                                  |
| `worker_already_running`         | `worker start --foreground` found a background worker already running for this instance                 |
| `worker_start_failed`            | `worker start` spawned the background worker but it did not answer within 15 seconds                    |
| `worker_base_url_mismatch`       | `worker start --base-url` or `worker add` named another server than the one the instance is bound to    |
| `worker_not_running`             | A `worker` command needs the instance's background worker and none is running (exit `3`)                |
| `worker_version_mismatch`        | The running worker is another version or protocol than this CLI; run `worker stop && worker start`      |
| `worker_unresponsive`            | The worker's process is alive but its control API does not answer                                       |
| `worker_request_failed`          | The worker answered a control-API request with an error                                                 |
| `unknown`                        | Anything not classified above                                                                           |

These are the CLI's own failures. A Task run the worker aborts has its own error code on the server: a run
aborted by [`scarn worker stop --force`](#scarn-worker-stop) fails with `WORKER_STOPPED`.

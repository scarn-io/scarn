---
title: Running Workers
description: Run the background worker that claims and runs tasks from the server
---

A **worker** is a long-running process that polls the Scarn server for pending tasks, claims them under a time-limited lease, executes them using a local Docker environment, and reports results back. Each machine runs one worker in the background, and it works on every project you add to it.

## Start a worker

```bash
scarn work
```

This starts the machine's background worker if it isn't already running, adds the project in your checkout to it, and returns; follow it with `scarn worker status` and `scarn worker logs -f`. The worker runs continuously, polling your project's task queue every 5 seconds. When a poll finds nothing to claim, the interval doubles, up to once every 10 minutes, and drops back to 5 seconds as soon as it claims work. With [push wake-up](#push-wake-up) connected, an idle worker still picks up new work within seconds.

If your current directory contains `.scarn/scarn.jsonc`, the project is read from it automatically. Otherwise pass it explicitly, as `owner/slug` (see [Project refs](/scarn/reference/cli/#project-refs)):

```bash
scarn work <owner/slug>
```

Run `scarn work` again in another checkout to add that project too. Running it again for a project that's already added updates its settings.

## Manage the background worker

```bash
scarn worker status
scarn worker logs acme/app -f
scarn worker config --max-concurrency 4
scarn worker remove acme/app
scarn worker stop
```

- **Projects.** The worker remembers each project's repository directory, limit and `--work-item-id` filter. They're saved, so when the worker starts again every project comes back. `scarn worker remove` forgets one; its running runs finish first. The project's `.scarn/.env` is read again for every claim.
- **Limits.** `--max-concurrency` caps how many runs the worker has going at once across every project (`1` until you set it; `SCARN_WORK_CONCURRENCY` sets the first value). `scarn work -c <n>` caps one project within that. When there isn't room for every project, the free slots go to projects in the order they asked. Lowering a limit, or removing a project, never stops a run that's already going.
- **Stopping.** `scarn worker stop` stops claiming and waits for running runs to finish. `scarn worker stop --force` aborts them, and each one fails with the code `WORKER_STOPPED`. A worker that crashes or is killed doesn't resume its runs; the server marks them abandoned. After a reboot, run `scarn worker start` (or `scarn work`) to bring it back.
- **Cancelling one run.** `scarn worker cancel <taskRunId>` cancels the run's Task on the server, then stops it on this machine straight away. A Task that a pipeline step owns cancels the whole pipeline run, so it asks first. Code Tasks can't be cancelled.
- **Problems.** `scarn worker status` shows a project that can't claim, with the reason: its repository is gone, the project isn't reachable, or its sign-in failed or now belongs to another user. Its running runs carry on, and it retries by itself. Fix your sign-in with `scarn auth login`; the worker picks it up without a restart.
- **Upgrades.** The CLI only talks to a worker of its own version. After upgrading, run `scarn worker stop && scarn worker start`.
- **In a terminal.** `scarn worker start --foreground` runs the worker in your terminal instead of in the background. The first Ctrl-C lets running runs finish; the second aborts them.

The worker's files are in `~/.scarn/workers/scarn/`: `worker.log` (rotated by size and by day) and `worker.stdio.log`, which catches anything printed before the log opens. A worker belongs to one server. To run against another one on the same machine, start a separate worker with `SCARN_WORKER_INSTANCE=<name>`; it gets its own directory, saved projects and limit. Every command is in the [CLI reference](/scarn/reference/cli/#scarn-worker).

## Push wake-up

A backed-off worker would otherwise take up to 10 minutes to notice new work. Push wake-up closes that gap: the worker holds a WebSocket open to Scarn's wake-up service, and when a run is queued for your project the server tells every connected worker to poll now. There's nothing to configure. The worker connects automatically when the server supports it, and the worker log shows `Push wake-up connected`.

The message is only a hint. It carries no task data, and the worker still claims work through the normal poll, so a missed message only costs latency:

- **On every (re)connect** the worker polls straight away, so it catches anything queued while it was disconnected.
- **While connected,** an empty poll waits a full 60 minutes before the next safety-net poll (`SCARN_WORK_CONNECTED_MAX_POLL_INTERVAL_MS`; see [Polling backoff](/scarn/reference/cli/#polling-backoff)).
- **If the connection drops** (the log shows `Push wake-up disconnected; polling`), the worker falls back to the normal 10-minute backoff right away and keeps retrying the connection in the background.
- **If the server has push wake-up turned off,** the worker just polls, exactly as before.

The connection is outbound only, over `wss://` to a `*.workers.dev` host. If a firewall or proxy blocks that, the worker keeps working and polls instead.

## Worker flags

Flags are in the [CLI reference](/scarn/reference/cli/#scarn-work-project).

## How execution works

1. **Poll** — The worker calls the server to claim a batch of pending tasks.
2. **Claim** — Each claimed task is assigned a lease. The worker sends heartbeats to extend the lease while processing.
3. **Environment setup** — The worker clones your repository for every runtime, loads the environment (the named environment version the run uses, from Scarn, or the step's inline settings), and selects the code checkout before resolving the runtime. See [Environments](/scarn/guides/environments/) for defaults and source policy. Devcontainer steps launch your selected config; managed steps launch a worker-supplied container. Agent containers receive mounts for a pinned Scarn-managed OpenCode runtime and a session-scoped agent home. Host steps skip the container, not the checkout.
4. **Agent startup** — For devcontainer and managed agent steps, OpenCode runs **inside that same container**, launched by absolute path from the mounted runtime payload—never the project's Node or a global `opencode`. There is no separate AI container, cross-container network, or MCP-host bridge. Host steps run the same Scarn-managed OpenCode runtime directly on the worker host against the repository checkout.
5. **Agent execution** — The step is handed to the in-container OpenCode agent with the step's prompt, input payload, and any configured MCP servers. First, every [connector](/scarn/guides/environments/#connectors) and every server in the step's `mcps` must report `connected` within 60 seconds, or the run fails with `SCARN_CONNECTOR_UNAVAILABLE`. Provider access is resolved through a normalized contract (currently `direct` mode: an explicit provider base URL + token, with your local OpenCode config as a fallback source).
6. **Result parsing** — The agent's structured output is parsed and checked against the step's `result` schema.
7. **Report** — The worker marks the task complete (or failed) and posts the result back to the server.
8. **Cleanup** — The Docker environment is torn down (unless `--preserve-runtime-on-complete` is set).

### Devcontainer config

A step selects a non-default devcontainer config with `Runtime.devcontainer({ config })`, where `config` is the full repo-relative path to the file. The worker resolves it in the clone, on the branch the step is based on, before the container launches. An explicit config has **no fallback**: if it is missing, the step fails without launching anything, and the failure names the path and that branch:

```
Devcontainer config not found: .devcontainer/frontend/devcontainer.json (branch "scarn/build-frontend-1234")
```

The branch in the message is the one the step was created off: your base branch for the first write step (see [Base branch](#base-branch)), or the work branch of the nearest earlier step that produced one for a later step. If a step expects a config that an earlier step is supposed to add, check that branch. A config path that resolves outside the clone (for example through a symlink) is rejected with `... resolves outside the cloned repository`. A `--dry-run` for the step resolves the same config, so a wrong path shows up in the dry-run report.

The worker patches the config it launches (mounts, ports, and `containerEnv`), and does not commit that patched file to the step's work branch. See [Selecting a devcontainer config](/scarn/guides/steps/#selecting-a-devcontainer-config) and [Multiple configs](/scarn/how-to/devcontainer/#multiple-configs).

### Managed runtimes

A [code step](/scarn/guides/steps/#code-steps) runs in a managed runtime (`Runtime.managed.<id>()`, default `bun1`) unless it opts into `Runtime.devcontainer()`. An agent step can opt into one explicitly (see [Managed runtimes for agent steps](/scarn/guides/steps/#managed-runtimes-for-agent-steps)). The worker still clones your repository, but it launches its own container instead of your devcontainer config. For each run it:

1. Looks up the identifier in its registry for the image (`oven/bun:1.4.0-debian` for `bun1`, `node:24-bookworm-slim` for `node24`).
2. For a code step, picks the dependency install from the lockfile in the clone's `.scarn/pipeline-builder` (see [Runtime for code steps](/scarn/guides/steps/#runtime-for-code-steps)). An agent step gets no install; instead the worker mounts the OpenCode runtime payload and runs the agent inside the container, as it does for a devcontainer.
3. Writes a generated `devcontainer.json` to `.scarn/managed-devcontainers/<id>/devcontainer.json` **inside the clone**, and launches from it.

That directory exists only in the clone for the run. It is excluded from work-branch commits and is never committed to your repository. It holds a devcontainer config that names an image, not an image, and it is unrelated to the host-side `~/.scarn/runtimes/` directory where the worker caches the OpenCode runtime payload.

A worker only knows the identifiers its version ships. If a step names one it does not know, for example because the step was pushed with a newer SDK than the worker's CLI, the step fails before anything launches, and the failure names the identifier and the ones the worker supports:

```
Managed runtime "node26" is not supported by this worker. Supported managed runtimes: bun1, node24. Upgrade the Scarn CLI to a version that supports it.
```

Upgrade the CLI on the worker host to fix it. Because image tags move with the worker version, a worker upgrade can also change the runtime under every managed step.

## Work branches

For steps that use [`Repo.readWrite()`](/scarn/guides/steps/#repo-access) (the default on every runtime), the worker creates a dedicated git branch for each task after cloning, commits changes to it, and pushes it. What a step does with the repository is set by its top-level `repo` option: see [Read-only steps](#read-only-steps) and [Commit message and push failures](#commit-message-and-push-failures) below.

Branches are named `<prefix>/<stepKey>-<taskId>`. The prefix defaults to `scarn`. To use your own prefix, add `branchPrefix` to the repo's `.scarn/scarn.jsonc`:

```jsonc
{
  "project": "acme/web-app",
  "branchPrefix": "myteam",
}
```

With the config above, a step keyed `build` produces a branch like `myteam/build-<taskId>`.

Notes:

- The prefix is sanitized to a valid git ref (whitespace and unsafe characters become `-`). If it is missing, empty, or sanitizes to nothing, the worker falls back to `scarn`.
- The prefix is read from the cloned repo's config on disk, so it lives alongside the code it applies to.

### Read-only steps

A step with `Repo.readOnly()` still clones the repo and checks out its base branch (see [Base branch](#base-branch)), but the worker creates no work branch, commits nothing, and pushes nothing. The task reports no work branch, so no branches pile up on your remote for steps that only read code. Edits the agent makes stay in the workspace and are discarded with it. This is a policy, not a sandbox: the repository is not mounted read-only.

Host steps follow the same repository policy as container steps.

### Private submodules and dependencies

Git inside the dev container has no credentials of its own. By default the worker answers git's credential requests from the container with the worker machine's own git credentials, for your repo's host only (add more with [`SCARN_GIT_CREDENTIAL_HOSTS`](#git-credentials)). So a `postCreateCommand` that runs `git submodule update --init` for a private submodule, or a package install that pulls a private git dependency, just works. Nothing goes into `.scarn/.env` or your `devcontainer.json`. Pushing from inside the container is blocked: the worker pushes the work branch itself. A step opts out with `gitCredentials: "none"` on its repo (see [Git credentials](/scarn/guides/steps/#git-credentials)), and you can turn it off for the whole worker with [`SCARN_GIT_CREDENTIALS=off`](#git-credentials).

### Commit message and push failures

The commit message defaults to `scarn: task <taskId>`. A step sets its own with `Repo.readWrite({ message })`, rendered from the step's input and the result the agent submitted. The rendered subject is single-line, at most 200 characters, and falls back to the default when empty. The same message is used for submodule commits. See [Repo access](/scarn/guides/steps/#repo-access) for the token rules.

:::caution[Behavior change: a failed push now fails the step]
Previously the worker logged a failed push and carried on, so a step could finish green with its work pushed nowhere. Now a failed push of the work branch, or of a submodule's work branch, **fails the step** with a message that names the branch and carries the git error, for example `Failed to push work branch "scarn/build-1234": <git error>`. This applies to every `readWrite` step, including steps that never wrote a `repo`. Existing steps get `onPushFailure: "fail"` recorded when the database is migrated.

The step fails before it is reported complete, so the result the agent submitted is **discarded** along with the push. A rerun repeats the agent run.

To keep the old behavior for a step whose work is expendable, opt out:

```typescript
repo: Repo.readWrite({ onPushFailure: "warn" }),
```

With `"warn"` the failure is logged and the step finishes as before, except that it reports **no work branch**: the branch is not on the remote, so a later step does not build on it (see [Base branch](#base-branch)) and its work is not handed on. A submodule whose push failed is still left out of the superproject commit, so the superproject never records a commit that cannot be fetched.
:::

`readOnly` steps never push, so they are not affected.

### Base branch

The worker always clones the repo, then checks out the step's **base branch**: the branch the step starts from. A `readWrite` step commits to its work branch: by default a new `scarn/<key>-<id>` created off the base, or the base itself with [`WorkBranch.base()`](/scarn/guides/steps/#branches).

The base is the first match in this order:

1. **The same Task's continued branch.** A yielded previous run's work branch, else the last succeeded run's. This always applies, even when the step sets `baseBranch`: it's the same step continuing its own work.
2. **The step's rendered `baseBranch`**, when set (see [Branches](/scarn/guides/steps/#branches)).
3. **The previous step's work branch.** See the table below for how it's chosen.
4. **`SCARN_BASE_WORK_BRANCH`** in the project's `.scarn/.env`.
5. **`baseWorkBranch`** in `.scarn/scarn.jsonc`.
6. **The remote's default branch.**

The server supplies rules 1 and 3, sending the previous step's branch only when the step sets no `baseBranch`; the worker applies the rest. Chat runs keep their own order: a pinned base, then rule 5, then rule 6.

A failure here never falls back to the next rule. The run fails before the agent starts:

- `SCARN_REPO_BRANCH_NOT_FOUND`: the base doesn't exist on `origin`.
- `SCARN_REPO_BRANCH_INVALID`: `baseBranch` renders empty or to an invalid branch name, names a secret variable, or `WorkBranch.base()` would commit onto a base from rule 4, 5 or 6.
- `SCARN_ENVIRONMENT_UNRESOLVED`: a `{{env.X}}` in `baseBranch` names a variable the environment doesn't declare, or one that isn't set.

Neither the worker nor the environment picks the code a step runs on, and `scarn work` doesn't use your checked-out branch. To run against a local branch, push it to `origin` and name it: in the step's `baseBranch`, in `SCARN_BASE_WORK_BRANCH`, or in `baseWorkBranch`.

To configure a project base branch, set `baseWorkBranch` in `.scarn/scarn.jsonc`:

```jsonc
{
  "project": "acme/web-app",
  "baseWorkBranch": "develop",
}
```

You can override that configured value per worker with `SCARN_BASE_WORK_BRANCH` in `.scarn/.env`. A step's own `baseBranch` beats both.

How the previous step's branch (rule 3) is chosen:

| Situation                                                                     | Base                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Earlier step wrote a work branch                                              | That branch                                                                              |
| Earlier step is `readOnly` (no work branch), or a wait (`decision`, `reply`)  | Skipped: the walk continues to that node's predecessors                                  |
| Earlier step failed or is otherwise unsatisfied                               | Ignored; only satisfied runs count. A rerun's inherited satisfied runs keep their branch |
| Loop iteration after the first                                                | The previous iteration's branch, when it wrote one                                       |
| Node after a loop                                                             | The last iteration that wrote a branch                                                   |
| [Lanes](/scarn/guides/pipelines/#routes-splits-and-merges) started by a split | All share the base of the node that started them                                         |
| Node after a merge where every arriving lane ended on the same branch         | That branch                                                                              |
| Node after a merge where lanes ended on different branches                    | No single base: rule 3 doesn't apply, so rules 4–6 decide; the server logs a warning     |
| Nothing upstream wrote a branch                                               | Rules 4–6                                                                                |
| Earlier step used `onPushFailure: "warn"` and its push failed                 | It reported no branch, so it is treated as if it produced none                           |

If the resolved base branch cannot be fetched/checked out (for example it was deleted from the remote between steps), the step fails.

The run's environment diagnostics record the branches: the `baseBranch` template, the base, which rule won (`server` for rules 1 and 3, `step`, `worker`, `project` or `remoteDefault`), the work branch and the work mode.

## Git cache

To avoid a full network clone for every step, the worker keeps a local bare mirror of your repo on the worker machine and clones each step's workspace from it. The mirror is refreshed from your real remote before each clone, and the workspace's `origin` is still your real remote, so pushes behave exactly as before. If the cache can't be used for any reason (offline, a repo URL that embeds a password or token, a lock timeout), the worker logs `git-cache: falling back to plain clone (<reason>)` in the step log and does a normal clone.

| Env var               | Description                                                    | Default              |
| --------------------- | -------------------------------------------------------------- | -------------------- |
| `SCARN_GIT_CACHE`     | `on` or `off`. Any other value stops the worker with an error. | `on`                 |
| `SCARN_GIT_CACHE_DIR` | Absolute path of the directory that holds the mirrors          | `~/.scarn/git-cache` |

Both can be set in the environment or in `.scarn/.env` (the latter wins). There is no size limit; it is always safe to delete the cache directory, and it is rebuilt on demand.

Only your repo itself is cached. Submodules are not touched. When the cache is on, the worker passes `SCARN_GIT_CACHE_DIR` to the host-side environment of your devcontainer's `initializeCommand`, so a script in your repo can opt in to reusing the mirrors. Such a script must tolerate a missing mirror and treat the cache as read-only.

## Git credentials

By default, git in every `readOnly` or `readWrite` step's dev container can fetch private repositories with your worker's git credentials (see [Private submodules and dependencies](#private-submodules-and-dependencies)). These settings control it:

| Env var                           | Description                                                                                                                                               | Default                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `SCARN_GIT_CREDENTIALS`           | `on` or `off` (any case). `off` gives containers no credentials and leaves `devcontainer.json` untouched. Any other value stops the worker with an error. | `on`                                                 |
| `SCARN_GIT_CREDENTIAL_SOURCE`     | Where credentials come from. Only `host` (the worker machine's own git credentials) works today. Any other value stops the worker with an error.          | `host`                                               |
| `SCARN_GIT_CREDENTIAL_HOSTS`      | Comma-separated extra hosts (`host` or `host:port`) the container may get credentials for, besides your repo's host.                                      | none                                                 |
| `SCARN_GIT_CREDENTIAL_RELAY_BIND` | Address the worker's credential endpoint listens on.                                                                                                      | `127.0.0.1` on macOS and Windows, `0.0.0.0` on Linux |

All four can be set in the environment or in `.scarn/.env` (the latter wins). The container needs `curl` or `wget` for this to work. Compose-based dev containers, and dev containers whose `containerEnv` already sets `GIT_CONFIG_COUNT`, are skipped with one line in the step log; the step still runs. Every request is written to the step log, and issued tokens are masked there.

:::caution[Steps can read your git credential]
With credentials on, every repo step's container can obtain your worker machine's git credential for the allowed hosts, and that credential may be able to push. Anything in the container, the agent included, can read it. If you don't want that, set `SCARN_GIT_CREDENTIALS=off`. Step authors can opt a single step out with `gitCredentials: "none"`.
:::

## Step environment variables

A step can declare the environment variables it needs with [`environment.vars`](/scarn/guides/steps/#environment-variables). The worker handles them in three stages:

1. **Resolution.** Right after claiming an execution and fetching its definition, and before anything launches, the worker resolves the declared variables into one set of values. `value` entries are rendered against the run's input. `inherit` (`worker`) entries are read from the worker's environment: `.scarn/.env` merged over the worker's `process.env`, then the entry's `default`. `secret` entries are read from `.scarn/.env` by secret name, and the rest are fetched from Scarn in one request per run; `process.env` is not read for them (see [Project secrets](/scarn/guides/secrets/#where-the-value-comes-from)). A variable set to an empty string counts as set.
2. **Injection.** The resolved values are passed to the agent and to code steps. With `Runtime.devcontainer()` they are added to the in-container OpenCode process (and a code step's runner) as `docker exec -e NAME` arguments, with the value in the `docker` process's environment rather than on its command line, so they override the devcontainer's `containerEnv`. With `Runtime.host()` they are merged into the host process's environment. Variables with `applies: "setup"` or `"both"` are also passed to the host-side environment of `devcontainer up`, where `initializeCommand` sees them (see [Setup variables](/scarn/guides/steps/#setup-variables)). Only variable names are logged, never values.
3. **Masking.** Values of project-secret entries and of entries marked `secret: true` are registered with the log masker before the runtime starts. Values shorter than 4 characters are not masked.

Because the lookup happens on the worker, an `inherit` variable has to be set where the worker runs — in `.scarn/.env` or the worker's environment — not in `devcontainer.json`.

:::caution[`.scarn/.env` is no longer copied into the container]
The worker used to copy every `.scarn/.env` value into the devcontainer's `containerEnv`. It doesn't any more: only declared variables reach the container. If a step relied on an undeclared `.scarn/.env` value inside the container, declare it in the step's environment, for example as a `worker` variable (`{ "worker": "NAME" }`, or `Env.inherit()` inline), or as a `secret` variable if it's a [project secret](/scarn/guides/secrets/).
:::

### Missing required variables

If a required `inherit` variable (not `optional`, no `default`) is undefined on the worker, or a `secret` variable's name is in neither `.scarn/.env` nor the project's secrets, the step fails with `SCARN_ENVIRONMENT_UNRESOLVED` during the preflight, before the workspace is cloned or any container starts. The failure message lists **all** the missing names at once, each as `NAME`, `FROM (for NAME)` when `from` renames it, or `SECRET (project secret for NAME)`, and never any values:

```
Step declares required environment variables that are not set on the worker: WAREHOUSE_TOKEN, STAGING_DB_PASSWORD (project secret for DB_PASSWORD). Set them in .scarn/.env or the worker's environment, or mark them optional. For a project secret, set it in .scarn/.env or save it as a project secret.
```

Set the variables, or mark them `optional` or give them a `default`, and re-run. If the request to Scarn for secrets fails, the run fails with the same code and a message naming the secrets; set them in `.scarn/.env` or retry once Scarn is reachable. See [Failure codes](/scarn/guides/environments/#failure-codes). `inherit` also cannot read `SCARN_*` variables; such a definition is rejected when you push, by the server, and by the worker.

### Dry runs

`scarn work --dry-run --step-id <id>` (or `--pipeline-id <id>`) resolves and injects the step's env into the rehearsal environment, so a missing variable shows up as a launch error in the dry-run report. It never fetches project secrets: it prints `Secret NAME: from .scarn/.env` or `Secret NAME: will request from Scarn` for each one. A dry run has no run input, so `{{input.…}}` templates render as empty strings. With `--global-only` there is no step, hence no step env.

## Environment requirements

Docker, an AI provider, and a Scarn sign-in are listed in [Installation](/scarn/getting-started/installation/#requirements); which steps need Docker and a devcontainer is under [Runtime](/scarn/getting-started/concepts/#runtime). For a worker on a CI box, see [Authentication](#authentication).

## Single-job mode

For debugging or CI use cases, run a specific work item:

```bash
scarn worker start --foreground --once --work-item-id <id> --preserve-runtime-on-complete
```

This runs in the foreground, polls once for the specified item, waits for what it claimed, and keeps the container alive so you can inspect the execution environment. It saves nothing and doesn't start a background worker. If the background worker is running, the runs count toward its `--max-concurrency`.

## Clean up Docker networks

Newer single-container runs no longer create per-session Docker networks. This command remains as a maintenance utility to remove any unused Scarn runtime networks left over from older runs:

```bash
scarn runtime cleanup-networks
scarn runtime cleanup-networks --verbose
```

## Authentication

Workers use credentials stored in `~/.scarn/auth.jsonc`. If running in CI, set the `SCARN_BASE_URL` environment variable and ensure credentials are available (e.g., via a secret injected at `~/.scarn/auth.jsonc`).

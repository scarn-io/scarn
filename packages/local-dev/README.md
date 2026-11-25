# @scarn/local-dev

A private, seedable test project on your local stack. One command (`seed`)
puts the `acme-sandbox` project into a known state: one pipeline per engine
mechanic, plus work items that drive each branch. Then you run the real worker
against it the way a user would.

Unlike the public demo (`packages/core/src/demo-project/`), nothing here is
replayed history. Steps are really pushed, pipelines really published, and
runs really executed by the `scarn` worker.

## Prerequisites

```sh
docker compose up -d && bun run db:push   # once
ENABLE_DEV_LOGIN=true bun run dev         # leave running
```

- **Docker.** Steps run in the managed `bun1` container, except `ld-grill`,
  which runs on `Runtime.host()`.
- **An AI provider configured for OpenCode.** Most steps are AI steps. Only
  `ld-loop`, `ld-errors`, `ld-merges` and `ld-codestep-with-mcp` run without an agent;
  `ld-grill` also uses the `/grilling` skill.

## Commands

```sh
bun run --filter @scarn/local-dev seed      # every time you want a clean slate
bun run --filter @scarn/local-dev work      # add the sandbox to the background worker
bun run --filter @scarn/local-dev work -- -c 4                              # 4 tasks at once
bun run --filter @scarn/local-dev work -- --once                            # one task, then exit
bun run --filter @scarn/local-dev work -- --once --work-item-id <id>        # step one item through
bun run --filter @scarn/local-dev work -- --dry-run
bun run --filter @scarn/local-dev typecheck
bun run --filter @scarn/local-dev pull-inventory   # regenerate ld-codestep-with-mcp's typed catalog
```

Plain `work` runs `scarn work` in the sandbox checkout,
which starts the background worker if none runs and adds the project to it. It
returns once the project is added; the background worker keeps draining the
queue. Extra arguments (`-c`, `-k`, `--work-item-id`,
`--dry-run`) go to `scarn work`. Follow and control the worker with `worker`,
which forwards to `scarn worker <args>` with the same instance and server:

```sh
bun run --filter @scarn/local-dev worker status
bun run --filter @scarn/local-dev worker logs -f
bun run --filter @scarn/local-dev worker stop
```

The instance is `scarn-local-dev`, not `scarn-dev`. An instance saves the
server it works for on its first start, so sharing `scarn-dev` with a link
you also point at production would make `work` fail with a base URL mismatch.

`--once` runs `scarn worker start --foreground --once` in the sandbox checkout
instead. It polls a single time and claims one task (one pipeline step), not a
whole run, then exits once that task finishes. To take every item to its
outcome, use plain `work`.

Every command runs `apps/cli` from source with
`SCARN_WORKER_INSTANCE=scarn-local-dev` and `SCARN_BASE_URL` set to the local
server, so its worker, logs and saved settings stay apart from an installed
`scarn` worker.

## What `seed` does

`seed` always resets. There is no separate reset command.

1. **Guard.** Refuses unless `DATABASE_URL` and `BASE_URL` both point at
   localhost.
2. **Preflight.** Checks that the app is up at `BASE_URL`.
3. **Auth.** Uses your `~/.scarn/auth.jsonc` profile for `BASE_URL`. If you
   have none, it dev-logs in as `local-dev@scarn.local` and saves that
   profile. Other profiles are left alone.
4. **Project.** Finds or creates `acme-sandbox`, whose `gitUrl` is
   `~/.scarn-local-dev/acme-shop.git`.
5. **Admin and secrets.** Gives you the full admin permission set on the
   project, then saves the `LOCAL_DEV_API_KEY` project secret (created, or
   its value replaced).
6. **Reset.** Deletes the project's work items, runs, tasks and
   notifications. The project, steps and pipelines are kept; the next steps
   bring them up to date.
7. **Repo.** Rebuilds `template-mirror.git`, `acme-shop.git` and the
   `acme-shop` checkout from `github.com/scarn-io/demo-shop-template`,
   mirrors `src/local-test-project/.scarn/` (the pipeline sources) into the
   checkout, and vendors the local SDK as a tgz.
8. **Pipelines.** Runs `pipelines build`, commits and pushes to
   `acme-shop.git`, then runs `pipelines push`, which publishes the
   `local-secrets` environment before the steps and also publishes the
   pipelines and the `default`, `ld-schedule` and `ld-github-import` project
   automations, then enables `default` and `ld-schedule` with
   `automations enable`.
9. **Work items.** Upserts 28 work items. The default automation routes and
   queues each one as it becomes ready.
10. **Prints** the project URL and a table of each item's key, pipeline,
    expected outcome and id.

## Pipelines

Sources are in `src/local-test-project/.scarn/pipeline-builder/`. The shared
steps are in `steps.ts`, `ld-routes-all`'s in `routes-all-steps.ts`,
`ld-merges`'s in `merges-steps.ts`, `ld-secrets`'s in `secrets-steps.ts` and
`ld-codestep-with-mcp`'s in `mcp-steps.ts`.
The `local-secrets` environment `ld-secrets` runs in is defined in
`secrets-environment.ts`, and push publishes it before the steps. `shop.ts`
holds what the AI steps share.
`fields.demo` (the pipeline key without `ld-`) picks the pipeline, and the
other fields pick the branch.

Steps that reason or write (classify, triage, propose and apply a fix, plan
files, reproduce, write a test, summarise) are AI steps that read the work
item's title and description and work against the `acme-shop` checkout.
Where an AI step decides a branch, the work item's field reaches it as a hint
its prompt tells it to honor, and the seeded description agrees with it. So
`expect` is the usual outcome, not a guaranteed one. Steps that only exist to
exercise engine mechanics (`attempt`, `flaky`, `recover`, `edit-file`,
`collect-edits`, `grill-stopped` and everything in `merges-steps.ts`) stay code
steps, so those branches are exact.

| Pipeline               | Mechanics                                                                         | Branch driven by                                              |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `ld-linear`            | Linear chain, `succeed`. Also the default automation's `otherwise`                | —                                                             |
| `ld-choice`            | Conditional `next`, `otherwise`, several terminals including `fail`               | `severity`: `critical`, `minor`, `invalid`                    |
| `ld-decision`          | `decision` wait (approve / revise / reject), revise loops back with `feedback`    | `requiresApproval`, then you pick an action                   |
| `ld-reply`             | `reply` wait, loop back with the answer, `maxRuns`                                | `detail`: `thin` asks, `full` skips the question              |
| `ld-loop`              | Self-loop carrying input, `maxRuns`, `catch(Scarn.MaxRunsExceeded)`               | `passOnAttempt`: `3` passes, `99` gives up                    |
| `ld-errors`            | `retry`, `timeoutSeconds` → `Scarn.Timeout`, `catch(Scarn.StepFailed)`            | `failMode`: `throw`, `sleep`, `none`                          |
| `ld-lanes-merge`       | `each` with `maxConcurrency`, `toleratedFailures`, `.partial()` merge, `decision` | `files` (lane count), `failFiles` (lanes that throw)          |
| `ld-routes-all`        | `match: "all"`, always + conditional routes, partial and closing merges           | `category`, `affectedPages`                                   |
| `ld-merges`            | `.partial()` partial merge, closing merge, conditional and `each` lanes filtered  | `services`, `unhealthy`, `failingSuite`, `scan`, `advisories` |
| `ld-grill`             | Agent conversation, `maxTurns`, `catch(Scarn.MaxTurnsExceeded)`                   | The work item title is the topic; you answer in the UI        |
| `ld-secrets`           | Named environment (`local-secrets`) with a `secret` var, log masking              | The `LOCAL_DEV_API_KEY` project secret seed saves             |
| `ld-codestep-with-mcp` | Typed MCP tool step, code step calling `context.mcp`, declared error caught       | `sku`: `MUG-01`, `TEE-02` (short), `SCARF-09` (unknown)       |

`ld-schedule.ts` and `ld-github-import.ts` are project automations rather
than pipelines; see [Schedules](#schedules) and
[GitHub import](#github-import).

### Typed MCP calls

`ld-codestep-with-mcp` (`fields.demo: "codestep-with-mcp"`) calls the shop's
inventory, a dependency-free stdio MCP server in `.scarn/inventory-mcp.mjs`
that the worker starts with `bun` inside the `bun1` container. `inventory.ts` binds it to the typed catalog in
`mcp/inventory.tools.ts`, so tool names, arguments and results are
type-checked:

- `lookup-sku` is an MCP tool step (`inventory.tools.lookupSku.step()`). Its
  input is the tool's arguments, and the pipeline routes on its typed
  `found`.
- `reserve-order` is a code step with `mcps: { inventory }`. Its `fn`
  (`reserveOrderFn`) re-reads the stock with `mcp.inventory.lookupSku`, fails
  with its declared `Order.OutOfStock` when the order doesn't fit, and
  otherwise calls `mcp.inventory.reserveStock`. The pipeline catches
  `Order.OutOfStock` into `backordered`.

The catalog and `mcp/inventory.lock.json` are generated; don't edit them.
After changing a tool in `inventory-mcp.mjs`, run `pull-inventory`, which
lists the server's tools with the codegen `scarn mcp pull` uses. Stock resets
whenever the server restarts, so every run starts from the same numbers.

Routing items are seeded too: a closed item (never ready), a
`status: "resolved"` item (skipped) and one with no `demo` field (runs
`ld-linear`).

These items stop and wait for you in the UI: `decision-required`
(`review-fix`), `reply-thin` (`ask-for-details`), `lanes-clean` and
`lanes-tolerated` (`approve-edits`), and `grill`.

### Schedules

`ld-schedule.ts` holds the `ld-schedule` project automation. Its
`sweep-coupons` rule runs every 5 minutes (UTC) and starts the
`sweep-coupons` step as a scheduled Task, with no work item. The agent finds
the shop's coupon codes and creates a work item for each with its `create`
grant on `project`, keyed `coupon:<CODE>` and labelled `coupons`. The
`default` automation then routes each new item to `ld-linear`. Run it again
and it finds the same keys, so it creates nothing new.

Seed enables it, but nothing fires on its own until the minutely tick runs,
and the tick is off locally. To try it, start the worker (`work`), then
either:

- **Run now:** select **Run now** next to the schedule on the _Pipelines &
  Automations_ tab, or run
  `bun apps/cli/src/index.ts automations run ld-schedule sweep-coupons` from
  `~/.scarn-local-dev/acme-shop` with `SCARN_BASE_URL` set to the local
  server. This starts a run right away and doesn't change when the next
  scheduled run is.
- **The tick:** set `AUTOMATION_SCHEDULE_TICK_CRON_SECRET` in the root `.env`,
  restart `bun run dev`, and call the route the scheduler calls:

  ```sh
  curl -X POST -H "Authorization: Bearer $AUTOMATION_SCHEDULE_TICK_CRON_SECRET" \
    http://localhost:3000/api/internal/automations/schedules/tick
  ```

  It only fires schedules that are due, so outside a 5-minute mark it
  returns `fired: 0`. To have it fire on its own, call it every minute, as
  EventBridge does in production:

  ```sh
  while true; do
    curl -s -X POST -H "Authorization: Bearer $AUTOMATION_SCHEDULE_TICK_CRON_SECRET" \
      http://localhost:3000/api/internal/automations/schedules/tick; echo
    sleep 60
  done
  ```

  The previous run must have finished before the next one starts; a run that
  comes due while one is still open is recorded as a skip.

Follow it with **History** on the _Pipelines & Automations_ tab, the
**Scheduled** filter on _Runs_, or `automations list`.

### GitHub import

`ld-github-import.ts` holds the `ld-github-import` project automation, built
with the `@scarn/sdk/library/github` library. Its `import` rule runs the
`import-github` code step every 5 minutes. The step reads `scarn-io/scarn`'s
issues through GitHub's remote MCP server and upserts each one as a `github`
work item keyed `scarn-io/scarn#<number>`, labelled `github`, with GitHub's
own labels in `fields.githubLabels`. The first run reaches back 30 days;
later runs read only what changed since the newest imported update. The
`default` automation skips items labelled `github`, so imports don't start
pipelines.

It needs a GitHub token: any classic or fine-grained token with read access
to public repos' issues works. To try it:

1. Set `SCARN_LOCAL_DEV_GITHUB_TOKEN` and rerun `seed`, which saves it as the
   `GITHUB_TOKEN` project secret. The token stays on the worker; the step's
   container never sees it.
2. Start the worker (`work`).
3. Select **Run now** next to the schedule, or run
   `bun apps/cli/src/index.ts automations run ld-github-import import` from
   `~/.scarn-local-dev/acme-shop`.

Run it again and items whose issue hasn't changed come back unchanged.
Seed leaves the automation disabled, so it doesn't fail every 5 minutes
without a token; enable it with
`bun apps/cli/src/index.ts automations enable ld-github-import` to have the
tick run it. Without the secret, a run fails at startup with
`SCARN_ENVIRONMENT_UNRESOLVED`.

### Adding a demo

1. Add `ld-<name>.ts` in the pipeline-builder folder, with any new steps in
   `steps.ts`.
2. Add a `{ when: (r) => equal(r.workItem.fields.demo, "<name>"), to: ... }`
   route to `default.ts`.
3. Add work items with `fields.demo: "<name>"` and an `expect` to
   `src/work-items.ts`.
4. Rerun `seed`.

## Layout

```
packages/local-dev/src/
  seed.ts, work.ts,      entrypoints
  worker.ts
  config.ts              env-overridable constants
  guard.ts, auth.ts      localhost guard; profile or dev-login
  project.ts, repo.ts    find-or-create project; rebuild bare repo + checkout
  cli.ts                 runs `bun apps/cli/src/index.ts <args>` in the checkout
  work-items.ts          the fixture list; seed-work-items.ts upserts it
  pull-inventory-catalog.ts  regenerates ld-codestep-with-mcp's typed inventory catalog
  local-test-project/.scarn/pipeline-builder/   pipeline sources (edit these)

~/.scarn-local-dev/
  template-mirror.git/   cached mirror of the template
  acme-shop.git/         bare repo, the project's gitUrl. Worker branches land here
  acme-shop/             checkout where `work` runs (generated, don't edit)
```

The editing loop: change files in `src/local-test-project`, then rerun `seed`.
The checkout is generated output, so edits there are lost on the next seed.

## Environment overrides

| Env                             | Default                                              |
| ------------------------------- | ---------------------------------------------------- |
| `SCARN_BASE_URL`                | `http://localhost:3000`                              |
| `SCARN_LOCAL_DEV_DIR`           | `~/.scarn-local-dev`                                 |
| `SCARN_LOCAL_DEV_TEMPLATE_REPO` | `https://github.com/scarn-io/demo-shop-template.git` |
| `SCARN_LOCAL_DEV_TEMPLATE_REF`  | `main`                                               |
| `SCARN_LOCAL_DEV_EMAIL`         | `local-dev@scarn.local` (only used with no profile)  |
| `SCARN_LOCAL_DEV_API_KEY`       | `ld-sandbox-not-a-real-key-7f3a` (the seeded secret) |
| `SCARN_LOCAL_DEV_GITHUB_TOKEN`  | unset (`ld-github-import`'s `GITHUB_TOKEN` secret)   |

The scripts load the root `.env`, which supplies `DATABASE_URL`.

## Caveats

- Rerunning `seed` wipes any runs you were inspecting.
- `errors-sleep` takes about 2 minutes, until its step timeout fires.
- `ld-agent-ask` (an agent that asks mid-task) isn't built yet.
- Running `pipelines build` inside `src/local-test-project` writes `ld-*.json`
  files there. They're gitignored.

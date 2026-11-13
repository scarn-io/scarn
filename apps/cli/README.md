# @scarn/cli

Scarn runs AI agents over your backlog, on your machines. This CLI links your
repo, designs pipelines with an agent, and runs the workers that execute them.

## Install

```sh
npm i -g @scarn/cli
```

## Use

```sh
scarn init               # sign in and link this repo to a Scarn project
scarn pipelines design   # pick a work item; an agent interviews you and writes the pipeline
scarn work               # start the background worker and add this project to it
```

The worker runs in the background, one per machine, and can run several
projects at once. Manage it with `scarn worker`:

```sh
scarn worker status      # the worker, its projects and its runs
scarn worker logs -f     # follow the worker log
scarn worker cancel <taskRunId>
scarn worker stop        # let running runs finish, then exit (--force aborts them)
```

The designer connects to an AI provider once, the first time it starts. The
Quickstart says
[which option to pick for your tool](https://scarn-io.github.io/scarn/getting-started/quickstart/#connect-your-ai-tool).

## Docs

- [Quickstart](https://scarn-io.github.io/scarn/getting-started/quickstart/) — ten minutes to a running pipeline.
- [CLI reference](https://scarn-io.github.io/scarn/reference/cli/) — every command and flag.
- [Observability](https://scarn-io.github.io/scarn/reference/observability/) — what the CLI reports and how to opt out.

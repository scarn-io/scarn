# Scarn

Scarn runs AI agents over your issues in multi-step pipelines. A worker runs on your machine with your AI provider; the dashboard shows what happened at each step, including reports, traces, and proposed changes.

## Star the repo

If you find it useful, [star the repo](https://github.com/scarn-io/scarn).

![A Scarn worker reproduces a bug in the browser and proposes a fix](.github/assets/hero-loop.gif)

[Watch the 75-second walkthrough](https://scarn.io/hero.mp4)

## The problem

A bug lands in your tracker. Someone has to read it, work out if it's even actionable, ask the reporter for the missing details, pull the branch, reproduce it, and *then* start fixing. Most of that is not engineering — it's legwork that gets done late, by whoever draws the short straw.

**Scarn does the legwork.** By the time a human opens the ticket, there's already a report on what was tried, a trace of the bug happening, a failing test that proves it, and a fix waiting for approval.

## Quickstart

You'll need a repository with an `origin` remote, Node or Bun, and an AI provider supported by [OpenCode](https://opencode.ai).

```sh
npm i -g @scarn/cli
cd your-repo
scarn init
scarn work
```

`scarn init` links the repo to a project and helps you design a pipeline. `scarn work` starts a worker to run it. See the [full quickstart](https://scarn-io.github.io/scarn/getting-started/quickstart/) if you need help connecting a provider or setting up a devcontainer.

## How it works

Pipelines define what an agent does at each step and when the work can move on. For example, an issue can be triaged, reproduced in a browser, and fixed only after a human approves the change. The agent does the work; pipeline rules decide whether the result is enough to continue.

Workers run in your repository's environment, on your hardware. The hosted [dashboard](https://app.scarn.io) stores the pipeline and run history; execution happens on your workers.

[Docs](https://scarn-io.github.io/scarn/) · [CLI](apps/cli) · [SDK](packages/sdks/js) · [Open an issue](https://github.com/scarn-io/scarn/issues)

## Why "Scarn"?

This repo strives to make your agents to be just as effective as the best agent of all time, Michael Scarn.

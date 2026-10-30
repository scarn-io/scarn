<div align="center">

# Scarn

**Every bug report gets investigated, reproduced, and fixed — before an engineer ever picks it up.**

AI agents run multi-step pipelines over your issues, on your own machines, with your own AI provider.
Each step leaves evidence: an investigation report, a Playwright trace, a failing test, a proposed fix.

[![npm](https://img.shields.io/npm/v/@scarn/cli?label=%40scarn%2Fcli&color=cb3837)](https://www.npmjs.com/package/@scarn/cli)
[![license](https://img.shields.io/github/license/scarn-io/scarn?color=blue)](./LICENSE)
[![release](https://img.shields.io/github/v/release/scarn-io/scarn)](https://github.com/scarn-io/scarn/releases)
[![docs](https://img.shields.io/badge/docs-scarn-7c3aed)](https://scarn-io.github.io/scarn/)

[**Quickstart**](#quickstart) · [**How it works**](#how-it-works) · [**Docs**](https://scarn-io.github.io/scarn/) · [**Website**](https://scarn.io)

<br/>

![A GitHub issue arrives, a worker claims it, the agent reproduces the bug in a browser and opens the Playwright trace, then proposes a fix](.github/assets/hero-loop.gif)

<sub>Real run, real timings. [Watch the full 75-second walkthrough →](https://scarn.io/hero.mp4)</sub>

</div>

---

## Star Scarn

If Scarn is useful to you, [give the repo a star ⭐](https://github.com/scarn-io/scarn) to help others find it.

## The problem

A bug lands in your tracker. Someone has to read it, work out if it's even actionable, ask the reporter for the missing details, pull the branch, reproduce it, and *then* start fixing. Most of that is not engineering — it's legwork that gets done late, by whoever draws the short straw.

**Scarn does the legwork.** By the time a human opens the ticket, there's already a report on what was tried, a trace of the bug happening, a failing test that proves it, and a fix waiting for approval.

## What you get

| | |
|---|---|
| 🔍 **Triage that asks for what's missing** | Thin report? The agent asks the reporter for details instead of guessing. Actionable? It gets to work. |
| 🎭 **Reproduction with proof** | The agent drives your app in a real browser. You get a **Playwright trace**, not "I think I reproduced it." |
| 🧪 **Failing test → proposed fix** | A confident repro turns into a failing test, then a fix that **blocks for your approval** in the dashboard. |
| 🏠 **Runs on your hardware** | Workers run on your laptop or CI box, inside your repo's devcontainer. Code and data never leave your network. |
| 🔑 **Your AI provider** | Anthropic, OpenAI, GitHub Copilot, or anything [OpenCode](https://opencode.ai) supports. Scarn never touches your keys. |
| 📐 **Policy over vibes** | Agents make judgments; **deterministic rules** over typed signals decide what those judgments are allowed to do. |

## Quickstart

Ten minutes, one terminal. You'll need a repo with an `origin` remote, Node or Bun, and an AI tool you already use (Claude Code, Codex, Copilot, or an API key).

```bash
npm i -g @scarn/cli
cd your-repo
scarn init
```

`init` links your repo, syncs your GitHub or Jira issues in as work items, and hands you to the **designer** — an agent that reads your repository, interviews you about one real work item, and writes a pipeline for it:

> *What should come out the other end?* · *What can the agent reach?* · *What must it never touch?*

It writes the pipeline (and a devcontainer, if you don't have one), pushes it, and offers to run it right there:

```bash
scarn work   # a worker claims steps, runs the agent, uploads the evidence
```

Open the dashboard, watch the run, click **View trace**. That's the whole loop.

→ [Full quickstart with transcripts](https://scarn-io.github.io/scarn/getting-started/quickstart/) · [Using Claude Code or Codex? Paste the docs URL and say "follow the quickstart"](https://scarn-io.github.io/scarn/llms-full.txt)

## How it works

Pipelines are plain TypeScript. A **step** is an agent prompt with a typed result. A **signal** is a value pulled out of that result. **Rules** over signals decide what happens next — branch, loop, block for a human, or continue.

```ts
import { definePipeline, Rule } from "@scarn/sdk/definitions/pipelines";
import { triage, reproduce, writeFailingTest, proposeFix } from "./steps";

export default definePipeline({
  key: "bug-pipeline",
  startAt: "triage",
  states: {
    triage: {
      kind: "step",
      step: triage,                                   // scores the report, asks for details if too thin
      next: "reproduce",
    },
    reproduce: {
      kind: "step",
      step: reproduce,                                // drives the app, saves a Playwright trace
      next: "confident",
    },
    confident: {
      kind: "choice",
      choices: [{ when: Rule.when("confidence", "greaterThanInclusive", 0.8), next: "failingTest" }],
      default: "needsHuman",
    },
    failingTest: { kind: "step", step: writeFailingTest, next: "fix" },
    fix: {
      kind: "step",
      step: proposeFix,
      blockWhen: Rule.when("approved", "equal", false), // stops in the dashboard until you say go
      next: "done",
    },
    needsHuman: { kind: "fail" },
    done: { kind: "succeed" },
  },
});
```

The agent decides *how* to reproduce the bug. The pipeline decides *whether that was good enough to continue*. That split is the whole idea: fuzzy judgment where you need it, hard policy where you can't afford to be wrong.

- Every step gets the full output of the steps before it.
- Anything the agent writes to its artifacts directory is uploaded and shown on the step — traces open in Playwright's trace viewer.
- Steps run on the host or inside your `.devcontainer`, with the MCP servers and skills your repo already defines.
- `step`, `choice`, `loop`, `fanOut`, `parallel`, `split`, `succeed`, `fail` — enough to express real workflows, not just chains.

→ [Core concepts](https://scarn-io.github.io/scarn/getting-started/concepts/) · [Steps](https://scarn-io.github.io/scarn/guides/steps/) · [Pipelines](https://scarn-io.github.io/scarn/guides/pipelines/) · [Advancement rules](https://scarn-io.github.io/scarn/guides/pipeline-advancement/)

## Why not just a coding agent?

Coding agents are great at the *doing*. They're bad at knowing when to stop, what evidence to leave behind, and when a human actually needs to look. Scarn wraps the agent you already use in the parts it's missing:

- **Evidence, not assertions.** Reports, traces, and tests you can check — not a chat log claiming success.
- **Human attention only where it's needed.** The default pipeline has exactly three gates: is the report actionable, was the repro confident, do you approve the fix.
- **Your infra, your provider, your rules.** No third-party execution environment. No shared compute. Nothing to get a security review for.
- **Beyond bugs.** The same machinery runs backlog features, multi-stage review/refactor passes, or any repeatable multi-step task you'd want an agent to own end-to-end.

## What's in this repo

| Path | What it is |
|---|---|
| [`apps/cli`](apps/cli) | The `scarn` CLI — `init`, `pipelines design`, `work`, and friends |
| [`packages/sdks/js`](packages/sdks/js) | `@scarn/sdk` — `defineStep`, `definePipeline`, `Rule`, and the typed API client |
| [`packages/worker`](packages/worker) | The worker that claims tasks and runs agents on your machine |
| [`packages/opencode-plugin`](packages/opencode-plugin) | The OpenCode plugin that runs inside each step |
| [`packages/pipeline-studio-ui`](packages/pipeline-studio-ui) | The live pipeline graph (`scarn pipelines studio`) |
| [`apps/docs`](apps/docs) | The documentation site |

The CLI, SDK, worker, and plugin are MIT-licensed. The hosted control plane at [app.scarn.io](https://app.scarn.io) stores your pipelines, work items, and run history; all execution happens on your workers.

## Status

Early and moving fast. The flagship bug pipeline works end to end today. If you try it and something breaks or feels wrong, **please open an issue** — real feedback from real repos is the most useful thing you can give this project right now.

`scarn report-bug` will file one for you with the diagnostics attached.

## Why "Scarn"?

This repo strives to make your agents to be just as effective as the best agent of all time, Michael Scarn.

---
title: Installation
description: Install the Scarn CLI
---

## Requirements

To get through [Quickstart](/scarn/getting-started/quickstart/)'s first
pipeline run, you need:

- **A git repository with an `origin` remote** — `scarn init` reads the
  remote to find or create your project
- **Node.js** 18+ or **Bun** 1.3+ (or npm/pnpm/yarn — any one package manager, to
  install dependencies into `.scarn/pipeline-builder/`)
- **An AI provider** — the first design session connects one, and the
  [Quickstart's provider table](/scarn/getting-started/quickstart/#connect-your-ai-tool)
  says which menu entry to pick for Claude Code, Codex, or GitHub Copilot. Or
  export a provider API key such as `ANTHROPIC_API_KEY` before you start.
- **A Scarn sign-in** — `scarn init` signs you in. On a worker machine
  where you won't run `init`, use
  [`scarn auth login`](/scarn/reference/cli/#scarn-auth-login).
- **Docker**, running where the worker runs — for steps on
  `Runtime.devcontainer()`, the default for steps that work in your code. See
  [Runtime](/scarn/getting-started/concepts/#runtime) for which steps need it
  and where the devcontainer comes from.

You do **not** need OpenCode installed. Scarn downloads and pins its own
runtime the first time it's needed — a one-time ~100 MB download.

## Install the CLI

Install the `@scarn/cli` package globally via npm. It installs the `scarn` command:

```bash
npm i -g @scarn/cli
```

Or with Bun:

```bash
bun add -g @scarn/cli
```

Verify the installation:

```bash
scarn --version
```

The npm package ships pre-compiled binaries for macOS, Linux, and Windows — see
the full platform table in the [CLI reference](/scarn/reference/cli/#platform-binaries)
if you're troubleshooting an install.

## Next steps

`scarn init` handles signing in to Scarn and creating your project as
part of setup, and the design session it hands off to connects your AI
provider, so there's no separate login step to run first. Run it from anywhere in your repository; head to
[Quickstart](/scarn/getting-started/quickstart/) for the walkthrough.

Already signed in and just need the commands? See the
[CLI reference](/scarn/reference/cli/) for `scarn auth`, environment
variables, and every flag.

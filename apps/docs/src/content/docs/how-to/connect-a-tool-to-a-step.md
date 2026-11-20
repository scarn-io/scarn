---
title: Give a step an MCP server
description: Ask the designer to wire a tool into a step, keep its secret out of the definition, and check it connects
---

```bash
scarn pipelines design
```

Tell the designer which tools each step needs. A step gets only the MCP
servers it lists.

## Is it a connector? Turn it on in the environment

For a [connector](/scarn/reference/connectors/), use the environment's
`connectors` and [project secrets](/scarn/guides/secrets/), not `defineMcp`:

```jsonc
{
  "connectors": ["datadog"],
  "vars": {
    "DD_API_KEY": { "secret": "DD_API_KEY" },
    "DD_APPLICATION_KEY": { "secret": "DD_APPLICATION_KEY" },
  },
}
```

Every step using this environment gets the server. Duplicating its id in
`mcps` fails the run.

## Already in your repo? The step refers to it

The designer references existing repository servers with `defineMcp` and
mounts them under each step's `mcps`. See
[Referencing a server from your repository](/scarn/guides/steps/#referencing-a-server-from-your-repository).
[`.opencode/tools/` tools](/scarn/guides/steps/#tools-already-available-to-every-step)
load automatically for devcontainer steps.

## Otherwise, the designer writes it inline

The designer uses `type: "local"` for commands or `"remote"` for URLs:

```typescript
const postgres = defineMcp({
  type: "local",
  name: "postgres",
  command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
  environment: { DATABASE_URI: "{env:DATABASE_URI}" },
  healthChecks: { listSchemas: { tool: "list_schemas" } },
});
```

With `Runtime.host()`, local commands run on the worker host. See
[Local servers](/scarn/guides/steps/#local-servers) and
[Remote servers](/scarn/guides/steps/#remote-servers) for fields.

## Use a project connection

For a service in [MCP connections](/scarn/connections/), such as Notion or
Cloudflare Observability, connect it in project settings, then let the
designer add `auth: { connection: "<name>" }` to a repository `ref` or inline
`remote`. `connection` is the connection's name, and the server's URL must be
the connection's MCP URL:

```typescript
const notion = defineMcp({
  type: "remote",
  name: "notion",
  url: "https://mcp.notion.com/mcp",
  auth: { connection: "notion" },
});

const observability = defineMcp({
  type: "remote",
  name: "cloudflare-observability",
  url: "https://observability.mcp.cloudflare.com/mcp",
  auth: { connection: "cloudflare-observability" },
});
```

Scarn checks each URL against its connection when a run starts, and fails the
run with `SCARN_MCP_CONNECTION_AUTH_INVALID` if it doesn't match.
`scarn pipelines push` reports a mismatch earlier when the connection already
exists. See [Use the connection in a step](/scarn/connections/notion/#use-the-connection-in-a-step).

## Secrets: you give it a name, never a value

The designer references `{env:VAR}` in `environment` or `headers`, adds the
name to `.scarn/.env.example`, and tells you what to fill in:

```bash
cp .scarn/.env.example .scarn/.env
```

Fill `.scarn/.env` yourself; never commit it. Missing variables fail launch
unless listed in `optionalEnv`. See [Secrets](/scarn/guides/steps/#secrets)
for lookup order and shared secrets.

For optional checks, use
[`severity: "warn"`](/scarn/guides/steps/#severity) so failures don't block.

## Every server must connect before the first prompt

Every connector and declared server must report `connected` within 60 seconds, before
health checks and the first prompt. Otherwise the run fails with
`SCARN_CONNECTOR_UNAVAILABLE`, regardless of check severity. Servers only
in repository OpenCode config aren't checked. See
[Failure codes](/scarn/guides/environments/#failure-codes).

## Check it connects

After the push, dry-run the step:

```bash
scarn work --dry-run
```

Pick the step. For servers without `auth`, this starts servers and runs
[health checks](/scarn/guides/steps/#health-checks), without running the step.
The designer also checks after pushing; see
[Dry runs](/scarn/reference/cli/#dry-runs).

Servers with `auth` accept tool health checks. Choose a read-only tool:
real runs call it through OpenCode and Scarn's relay before the first prompt.
These are real provider calls. `env` and `optionalEnv` remain forbidden.

Dry runs and post-push checks instead list tools server-side (requiring
`executions:write`, possibly cached), never execute managed tools, and report
tool checks as **skipped: runs in real runs only** without blocking.
A connection that isn't serving blocks startup with reconnect guidance. See
[Dry runs don't start the server](/scarn/connections/notion/#dry-runs-dont-start-the-server).

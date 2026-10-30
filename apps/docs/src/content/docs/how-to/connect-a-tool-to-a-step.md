---
title: Give a step an MCP server
description: Ask the designer to wire a tool into a step, keep its secret out of the definition, and check it connects
---

```bash
scarn pipelines design
```

Name the tool when the designer asks how you'd work the item — "I'd check
the error in Sentry, then query the read replica." Each tool you name becomes
an MCP server on the step that needs it. A step gets only the servers it
lists.

## Already in your repo? The step refers to it

If your repository already defines the server (in `.opencode/opencode.json`,
`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, or `.codex/config.toml`),
the designer defines it once with `defineMcp`, with its environment variables
and health checks, and mounts it under `mcps` on each step that uses it
instead of copying the definition. See
[Referencing a server from your repository](/scarn/guides/steps/#referencing-a-server-from-your-repository).
Custom tools in `.opencode/tools/` load for every devcontainer step without
this; see
[Tools already available to every step](/scarn/guides/steps/#tools-already-available-to-every-step).

## Otherwise, the designer writes it inline

It asks how the step reaches the tool — a launch command, a package, or a URL
— and writes it as a `defineMcp` with `type: "local"` (or `"remote"` for a
URL), mounted under the step's `mcps`:

```typescript
const postgres = defineMcp({
  type: "local",
  name: "postgres",
  command: ["uvx", "postgres-mcp", "--access-mode=restricted"],
  environment: { DATABASE_URI: "{env:DATABASE_URI}" },
  healthChecks: { listSchemas: { tool: "list_schemas" } },
});
```

A step on `Runtime.host()` has no checkout, so its servers are always written
this way. Local and remote fields:
[Local servers](/scarn/guides/steps/#local-servers) and
[Remote servers](/scarn/guides/steps/#remote-servers).

## Secrets: you give it a name, never a value

When the server needs a token, password, or connection string, the designer
asks only for the **environment variable name** it should come from, and
proposes one if you don't have a convention. Then it:

1. references the variable as `{env:VAR}` in the server's `environment` or
   `headers` — never the value, because definitions are pushed to the server
   and shown in the dashboard;
2. adds `VAR=` to `.scarn/.env.example`;
3. names every variable it added when the session ends.

Your part:

```bash
cp .scarn/.env.example .scarn/.env
```

Fill in the real values in `.scarn/.env`. The designer never writes that
file, and no step that uses the variable will work until you do. Keep it out
of git — see [Commit and share your pipeline](/scarn/how-to/commit-your-pipeline/#secrets-envexample-vs-env).

The worker reads every `{env:VAR}` from `.scarn/.env`, then its own
environment, and a missing one fails the step before launch — unless the
server lists it in `optionalEnv`, so it launches without it. When a server only
helps a step, set its checks to `severity: "warn"` so a failed check doesn't
block the step. See [Secrets](/scarn/guides/steps/#secrets) and
[Severity](/scarn/guides/steps/#severity).

## Check it connects

After the push, dry-run the step:

```bash
scarn work --dry-run
```

Pick the step when asked. The dry run launches its environment, starts its MCP
servers, and runs any [health checks](/scarn/guides/steps/#health-checks) it
declares, then reports what connected — without running the step. The
designer's own post-push check runs every step's health checks; see
[Dry runs](/scarn/reference/cli/#dry-runs).

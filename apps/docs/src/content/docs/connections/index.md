---
title: MCP connections
description: What a project's MCP connection is, which services you can connect, and how steps refer to a connection by name
---

An MCP connection links a project to a hosted MCP server through that
service's own sign-in. Scarn keeps the access the service grants on its
servers, so nobody pastes a token into Scarn or onto a worker. A step whose MCP
server has `auth: { connection: "<name>" }` calls the service through Scarn
with that access.

## Services you can connect

| Service                                                    | Name                       | MCP URL                                        |
| ---------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| [Notion](/scarn/connections/notion/)                       | `notion`                   | `https://mcp.notion.com/mcp`                   |
| [Cloudflare Observability](/scarn/connections/cloudflare/) | `cloudflare-observability` | `https://observability.mcp.cloudflare.com/mcp` |
| Linear                                                     | `linear`                   | `https://mcp.linear.app/mcp`                   |
| Sentry                                                     | `sentry`                   | `https://mcp.sentry.dev/mcp`                   |
| Neon                                                       | `neon`                     | `https://mcp.neon.tech/mcp`                    |
| PostHog                                                    | `posthog`                  | `https://mcp.posthog.com/mcp`                  |
| Stripe                                                     | `stripe`                   | `https://mcp.stripe.com`                       |
| Netlify                                                    | `netlify`                  | `https://netlify-mcp.netlify.app/mcp`          |
| Atlassian                                                  | `atlassian`                | `https://mcp.atlassian.com/v2/mcp`             |

You can connect these from settings or from the CLI. Any other remote MCP
server in your repository's MCP config, such as
[Slack](/scarn/connections/slack/), can be connected from the CLI; see
[Connect from the CLI](/scarn/connections/cli/).

## Names and labels

Each connection has two names:

- **The name** is what a step's `auth: { connection }` refers to, such as
  `notion`. It's lowercase letters, digits and hyphens, at most 63 characters,
  and unique in the project. A connection added from settings takes the
  service's name from the table above; one added from the CLI takes the name
  you give it.
- **The label** is what Scarn shows people, such as "Notion", in settings, in
  `scarn pipelines push` output and in error messages.

Steps refer to a connection by name, not to one particular sign-in, so you
don't need to edit a step after you reconnect, or after you disconnect and
connect again.

## One connection per MCP URL

A project has at most one connection to each MCP URL. That way there is never
a question of which connection a step's URL belongs to. To act as a different
account, reconnect the existing connection.

## Add a connection

You need `secrets:write` in the project (see
[Project secrets](/scarn/guides/secrets/#save-a-secret)).

1. Open the project's **Settings** and go to **MCP connections**.
2. Click **Add connection** and choose the service. The menu lists only
   services the project isn't connected to yet.
3. Read the disclosure, sign in to the service and approve access, then come
   back and click **Confirm**.

Or, from the repository in a terminal:

```bash
scarn connections connect notion
```

See [Connect from the CLI](/scarn/connections/cli/).

Each connection gets its own card in **MCP connections**, with its state, the
account where the service says which one signed in, and buttons to reconnect
or disconnect. Every project member can see the cards; only members with
`secrets:write` can change them.

The service pages cover the details:
[Connect Notion](/scarn/connections/notion/) walks through connecting,
reconnecting, disconnecting and what each run does, and
[Connect Cloudflare Observability](/scarn/connections/cloudflare/) covers what's
different for Cloudflare, and [Connect Slack](/scarn/connections/slack/) covers
connecting Slack with a Slack app from your MCP config.

## Use a connection in a step

Add `auth: { connection: "<name>" }` to a `ref` or `remote` MCP server, and
make sure its URL is the connection's MCP URL. See
[Give a step an MCP server](/scarn/how-to/connect-a-tool-to-a-step/#use-a-project-connection).

Scarn checks the URL against the connection when a run starts, and
`scarn pipelines push` reports a mismatch earlier when the connection already
exists. See [Use the connection in a step](/scarn/connections/notion/#use-the-connection-in-a-step)
for the full rules.

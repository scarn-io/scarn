---
title: Connect Slack
description: Connect a project to Slack's hosted MCP server from the CLI, with a Slack app's client ID from your MCP config
---

A project can connect to Slack's hosted MCP server,
`https://mcp.slack.com/mcp`, from the CLI. Slack isn't in the
[list of services](/scarn/connections/#services-you-can-connect) you can connect
from settings: it only lets known Slack apps sign in, so you supply one in your
MCP config. Scarn then signs in as that app, keeps the access on its servers,
and runs reach Slack through Scarn as they do for
[Notion](/scarn/connections/notion/).

This page covers what's specific to Slack. See
[Connect from the CLI](/scarn/connections/cli/) for how CLI sign-in works.

## What connecting shares

:::caution
Anyone who can run steps in this project will be able to act in Slack as this
account, through the Slack app you supply.
:::

The connection acts as the Slack user who signed in, in the workspace they
chose, limited to the scopes they approved. It isn't limited to the person who
runs a step.

It also **acts as the supplied app**. Slack sees every request from the
connection as coming from the app whose client ID is in your MCP config. If
that's another tool's published app, Slack and your workspace admins see that
app, not Scarn. Use an app your workspace owns if that matters to you.

## Add Slack to your MCP config

You need a Slack app's client ID, the redirect it's registered with, and the
scopes to ask for. Scarn uses the client ID without a secret, so the app must
allow signing in without one.

In OpenCode's format (`.opencode/opencode.jsonc` or `opencode.json`):

```jsonc
{
  "mcp": {
    "slack": {
      "type": "remote",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "<your-slack-app-client-id>",
        "redirectUri": "http://localhost:<port>/callback",
        "scope": "users:read",
      },
    },
  },
}
```

In Claude's format (`.mcp.json`), `callbackPort` stands for
`http://localhost:<callbackPort>/callback`:

```json
{
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "<your-slack-app-client-id>",
        "callbackPort": 3118,
        "scope": "users:read"
      }
    }
  }
}
```

Use `redirectUri` or `callbackPort`, whichever matches the redirect the Slack
app is registered with. The CLI listens on exactly that port while you sign
in, so the tool the app belongs to can't be using it at the same time.

### Set the scopes

Set `oauth.scope`, separated by spaces, or pass `--scope` once per scope.
Choose only what your steps need. Without scopes, Scarn asks for every scope a
server advertises, and Slack advertises every scope it has, so you'd be asked
to grant far more than a step should have.

A connection's scopes are fixed when it's created. To change them, disconnect,
update your MCP config, and connect again.

## Connect

```bash
scarn connections connect slack
```

The key in your MCP config, `slack` here, becomes the connection's name and
its label. Before anything is stored, the CLI shows:

- the authorization server and the endpoint origins Slack signs in with,
  including `https://slack.com`;
- the adjustments Scarn needs because Slack doesn't follow the MCP
  authorization spec, such as its endpoints being on another origin and how it
  reports token errors;
- "Signs in as client `<client ID>` from your MCP config. The provider sees
  requests as coming from that app.";
- the scopes it will ask for.

Then sign in to Slack in your browser, approve access, and confirm in the
terminal, as in [Sign in and confirm](/scarn/connections/cli/#sign-in-and-confirm).

Slack doesn't tell Scarn which account signed in, so the CLI and the card say
the account can't be verified. Check which Slack workspace you're signed in to
before you approve.

## Use the connection in a step

Point the step's server at Slack's MCP URL and name the connection:

```typescript
const slack = defineMcp({
  type: "remote",
  name: "slack",
  url: "https://mcp.slack.com/mcp",
  auth: { connection: "slack" },
});
```

A `ref` to the entry in your MCP config works too: its `oauth` settings are
ignored in runs, and the connection is the only credential. The rules are the
same as for Notion; see
[Use the connection in a step](/scarn/connections/notion/#use-the-connection-in-a-step).

## Keep it working

Slack's access lasts a few hours, and Scarn renews it when it's next needed.
Scarn has no client secret, so it renews without one.
<!-- TODO(phase-10): record whether refresh without a client secret works through Scarn, and whether Slack accepts `resource` on refresh. Replace the next sentence with the outcome. -->

Signing in through Scarn works with a client ID from your MCP config. Whether
renewal through Scarn works for every Slack app hasn't been confirmed yet.

Slack's long-lived access expires after 30 days, and Scarn only renews when
something uses the connection. **A Slack connection nobody uses for 30 days
needs reconnecting**, even though its card shows a **Reconnect by** date
further out.

When Slack refuses a renewal, the connection shows **Reconnect required**.
Reconnect from the CLI; the card has no **Reconnect** button for Slack:

```bash
scarn connections reconnect slack
```

## Disconnect

Click **Disconnect** on the card in **MCP connections**. Scarn deletes its copy
of the access straight away. Slack names no endpoint to revoke access, so Scarn
sends Slack nothing, and the card reports the outcome as **Unconfirmed**.

To be sure the access is gone, remove it in Slack as well. Reconnecting or
cancelling doesn't revoke the access it replaces either. In Slack, click your
workspace name, then **Tools & settings** → **Manage apps** → **Installed
Apps**. Open the app the client ID belongs to, then **App Details** →
**Configuration**. Under **Authorizations**, click **See all** next to
**Authorized members** and **Revoke** your authorization. If app approval is
on, only Workspace Owners and app managers can do this. See Slack's
[Remove apps and custom integrations from your workspace](https://slack.com/help/articles/360003125231-Remove-apps-and-custom-integrations-from-your-workspace).

To connect Slack again after disconnecting, run
`scarn connections connect slack`.

## Privacy

- **Access tokens** are stored encrypted on Scarn's servers. They never reach
  workers, agents, logs, the CLI or your browser.
- **Identity:** Scarn doesn't read Slack's, so it stores none.
- **Audit events** record who connected, confirmed, reconnected or
  disconnected, and when, and are kept for 30 days.

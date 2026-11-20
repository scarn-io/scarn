---
title: Connect Cloudflare Observability
description: Connect a project to Cloudflare's Observability MCP server, and what's different from Notion
---

A project can connect to Cloudflare's Observability MCP server,
`https://observability.mcp.cloudflare.com/mcp`, through Cloudflare's own
sign-in. It works like the [Notion connection](/scarn/connections/notion/):
the same card in settings, the same confirm step, the same 180-day reconnect
date, and runs reach Cloudflare through Scarn in the same way. This page
covers what's different. See [MCP connections](/scarn/connections/) for names,
labels and the one-connection-per-URL rule.

## What connecting shares

:::caution
Anyone who can run steps in this project will be able to act in Cloudflare
Observability as this account.
:::

The connection acts as the Cloudflare account that signed in, with whatever
access that account approved. It isn't limited to the person who runs a step.

## Connect

You need `secrets:write` in the project.

1. Open the project's **Settings** and go to **MCP connections**.
2. Click **Add connection** and choose **Cloudflare Observability**. Read the
   disclosure, then click **Continue to Cloudflare Observability**.
3. Sign in to Cloudflare and approve access. You have 10 minutes.
4. Back in Scarn, check the permissions Cloudflare granted, then click
   **Confirm**. Nothing is connected until you confirm.

### Scarn registers itself with Cloudflare

Cloudflare doesn't let Scarn identify itself with a published app description,
as Notion does. Instead, the first time anyone connects to Cloudflare
Observability, Scarn registers itself as an app with Cloudflare's sign-in
server and keeps that registration. Later connections, in this project or any
other, reuse it. You don't need to do anything for this, and no secret is
involved.

If Cloudflare stops recognizing Scarn's registration, connections that use it
show **Reconnect required**. Reconnecting registers Scarn again.

### The account can't be verified

Cloudflare doesn't tell Scarn which account signed in. So:

- The confirm card says Cloudflare Observability didn't fully identify the
  account, so Scarn can't verify which account it is.
- Once confirmed, the card shows "Connected to Cloudflare Observability with
  an unidentified account".
- When you reconnect, Scarn can't tell whether you signed in as the same
  account as before, and the confirm card says so.

Check which Cloudflare account you're signed in to before you approve access.

## Use the connection in a step

Name the connection `cloudflare-observability` and point the server at
Cloudflare's URL:

```typescript
const observability = defineMcp({
  type: "remote",
  name: "cloudflare-observability",
  url: "https://observability.mcp.cloudflare.com/mcp",
  auth: { connection: "cloudflare-observability" },
});
```

A repository `ref` works too, as long as the repository's definition is remote
and its URL is Cloudflare's. The rules are the same as for Notion; see
[Use the connection in a step](/scarn/connections/notion/#use-the-connection-in-a-step).
A run whose URL isn't the connection's fails at launch with
`SCARN_MCP_CONNECTION_AUTH_INVALID`, and `scarn pipelines push` reports it
first when the project already has the connection.

## Disconnect

**Disconnect** deletes Scarn's copy of the connection's access straight away,
then sends Cloudflare one request to revoke it and shows the outcome:
**Accepted**, **Failed** or **Unconfirmed**. As with Notion, "accepted" is
only Cloudflare's answer to the request, not proof the access is gone.

Scarn doesn't link to a page in Cloudflare where you can remove its access,
because we haven't confirmed where Cloudflare lists it. To be sure access is
removed, check your Cloudflare account's settings for authorized apps or API
access.

Reconnecting or cancelling a connection doesn't revoke the access it
replaces: Scarn deletes its copy and sends Cloudflare nothing. That access
stays valid at Cloudflare until it expires or you remove it there.

## Privacy

- **Access tokens** are stored encrypted on Scarn's servers. They never reach
  workers, agents, logs or your browser.
- **Identity:** Cloudflare doesn't send any, so Scarn stores none.
- **Audit events** record who connected, confirmed, reconnected or
  disconnected, and when, and are kept for 30 days.

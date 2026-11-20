---
title: Connect Notion
description: Connect a project to Notion's hosted MCP server, and what connecting, reconnecting and disconnecting do
---

A project can connect to Notion's hosted MCP server through Notion's own
sign-in. Scarn keeps the access Notion grants on its servers, so nobody pastes
a Notion token into Scarn or onto a worker. A step that
[uses the connection](#use-the-connection-in-a-step) calls Notion through
Scarn.

The connection's name is `notion` and its label is "Notion". A project has
one connection per MCP URL, so at most one to Notion. See
[MCP connections](/scarn/connections/) for names, labels and the other
services you can connect.

## What connecting shares

:::caution
Anyone who can run steps in this project will be able to act in Notion as this
account.
:::

The connection acts as the Notion account that signed in, in the workspace it
chose, with whatever that account can see and do there. It isn't limited to the
person who runs a step. Connect an account whose Notion access you are willing
to give to every step in the project.

## Who can manage the connection

Open the project's **Settings** and go to **MCP connections**. The Notion
connection has its own card there.

| Who                                                                                        | Sees the connection | Connects, confirms, reconnects or disconnects |
| ------------------------------------------------------------------------------------------ | ------------------- | --------------------------------------------- |
| Members with `secrets:write` (see [Project secrets](/scarn/guides/secrets/#save-a-secret)) | Yes                 | Yes                                           |
| Every other project member                                                                 | Yes                 | No                                            |
| Anyone outside the project                                                                 | No                  | No                                            |

The card shows the connection's state, "Connected as _user_ in
_workspace_", the scopes Notion granted, who connected it, and the date to
reconnect by.

If you lose `secrets:write`, Scarn cancels your open connection attempts and
discards any unconfirmed connection you created, deleting its stored access.
It keeps already-confirmed connections: losing management permission doesn't
disconnect the project's Notion account.

## Connect

1. Click **Add connection** and choose **Notion**. If the project already has
   a Notion card that isn't connected, click **Connect Notion** on it instead.
   Read the disclosure, then click **Continue to Notion**.
2. Sign in to Notion and approve access. You have 10 minutes; after that the
   attempt expires and you start again.
3. Back in Scarn, check the Notion account, workspace and scopes, then click
   **Confirm**. Nothing is connected until you confirm, and an unconfirmed
   connection is discarded after 10 minutes. **Cancel** discards it at once.

Every connection needs this confirmation, including the first.

## Check that it works

Once a connection is confirmed, the card shows "Working — _N_ tools
available". Click **Show tools** to see each tool's name and description.
Tools that only read from Notion are marked **Read-only**.

"Working" means Scarn just used the connection to ask Notion's MCP server
which tools it offers, and Notion answered. It doesn't check what each tool
can reach in your workspace.

- **Only members who can run steps in the project see the tool list.** Other
  members see the connection without it.
- **The list can be up to 5 minutes old.** Scarn keeps it for up to 5 minutes
  before asking Notion again. After you reconnect, it asks again straight
  away.
- **If Notion can't be reached,** the card shows "Couldn't reach Notion to
  list tools. Try again." Click **Retry**. The connection itself is unchanged.

## Use the connection in a step

A step uses the connection only when one of its MCP servers says so with
`auth: { connection: "notion" }` in its
[`defineMcp`](/scarn/reference/sdk/#definemcp). `scarn pipelines design`
writes it for you, and lists the server's tools through the connection
instead of starting the server on your machine.

If your repository already defines the Notion server (in `.mcp.json`,
`.cursor/mcp.json` or another
[repository MCP config](/scarn/guides/steps/#referencing-a-server-from-your-repository)),
reuse it:

```typescript
const notion = defineMcp({
  type: "ref",
  name: "notion",
  auth: { connection: "notion" },
});
```

Otherwise, write it inline:

```typescript
const notion = defineMcp({
  type: "remote",
  name: "notion",
  url: "https://mcp.notion.com/mcp",
  auth: { connection: "notion" },
});
```

- **The URL must be Notion's MCP URL,** `https://mcp.notion.com/mcp`. Case in
  the scheme and host, a default port and a trailing slash don't matter; a
  query string or fragment is rejected. Write `url` yourself on an inline
  server: Scarn never fills it in from the connection.
- **Scarn checks the URL when a run starts.** `defineMcp` only checks that the
  URL is well formed, because which URL a connection has is known only to
  Scarn. When a run starts, the worker sends Scarn each server's URL, read
  from the repository for a `ref`. If it isn't the connection's, the run fails
  before the agent starts with `SCARN_MCP_CONNECTION_AUTH_INVALID`, naming the
  URL to use. `scarn pipelines push` reports the same mismatch earlier when
  the project already has the connection, and exits with
  `push_connection_url_mismatch` after publishing; see
  [`scarn pipelines push`](/scarn/reference/cli/#scarn-pipelines-push-project).
- **A referenced server must be remote.** If your repository runs Notion
  locally, for example with `npx mcp-remote …`, the step fails before launch.
  Switch the repository definition to the URL, or write the server inline.
- **The connection is the only credential.** The repository definition's own
  `headers` and `oauth` are ignored (only their names are logged), and the
  `{env:VAR}` variables they read aren't required. An inline server with
  `auth` can't set `headers`, `oauth`, `env` or `optionalEnv`.
- **Health checks can call tools.** A server with `auth` can declare
  `healthChecks`. Choose a read-only tool: in a real run, the check makes a real
  Notion call through Scarn before the agent's first prompt. See
  [Check it connects](/scarn/how-to/connect-a-tool-to-a-step/#check-it-connects)
  for what dry runs check instead.
- **Nothing is attached on its own.** A server at Notion's URL without `auth`
  never uses the connection. `scarn pipelines push` warns about it and
  suggests `auth: { connection: "notion" }`. If the step also has another
  server that uses a connection, its runs fail at launch with
  `SCARN_MCP_CONNECTION_AUTH_INVALID`; otherwise they start, and the server
  reaches Notion without the connection's access.

Referencing the connection needs only the permission any step save needs,
not `secrets:write`. You can push the step before Notion is connected:
`scarn pipelines push` prints the connection's status, such as "connected
as …" or "not connected", and the step's dialog in the web app shows "Authenticated by the
project's Notion connection" with the same status and a link to project
settings.

The step names the project's Notion connection, not one particular sign-in,
so you don't need to edit the step after you reconnect or disconnect and
connect again.

### How a run reaches Notion

When a run of the step starts, the worker registers it with Scarn and points
the step's Notion server at Scarn instead of at Notion. Scarn forwards each
call to `https://mcp.notion.com/mcp` with the connection's access. The worker
and the agent only hold a key that lets this run make calls through Scarn to
this connection, and nothing else. That key stops working when the run
stops, when its worker stops heartbeating, or when the connection is
disconnected, reconnected or needs reconnecting.

If the connection isn't working when the run starts, for example it isn't
connected or shows **Reconnect required**, the run fails before the agent
starts with `ManagedConnectionNotReady`, and a project admin must reconnect
Notion. Steps don't wait for reconnection or retry automatically. A pipeline's
catch route handles this like an ordinary step failure.

After reconnecting, re-run the failed work: use **Retry** in the app,
`scarn tasks retry`, or `scarn runs rerun --step` for the failed step. Check
for earlier Notion changes before re-running; they aren't rolled back.

### Dry runs don't start the server

`scarn work --dry-run` and the designer's post-push check ask Scarn to list
Notion's tools server-side instead of starting the connection's MCP server.
This needs `executions:write` and may use the cached tool list. A connection
that isn't serving blocks the check with guidance to reconnect in project
settings.

Neither check calls the connection's tools. Declared tool health checks on
this server report **skipped: runs in real runs only**, which doesn't block
the check. They execute through Scarn's relay and OpenCode in a real run.
Listing tools proves neither that a tool works nor that it can reach the
Notion data the step needs.

## What happens to a running step

A step that's running keeps the connection it started with. If, before the
step finishes, someone disconnects Notion, confirms a reconnect, or the
connection needs reconnecting because a renewal failed, the step fails with
`ManagedConnectionAuthorityLost`. That happens whether it was in the middle of
a Notion call or doing something else, and whatever it reported: its result
and work item changes aren't applied. A step that finished before the change
keeps its result. A Notion call whose outcome Scarn can't know also fails the
step. See [Errors, retries and timeouts](/scarn/guides/pipelines/#errors-retries-and-timeouts)
for the reasons the error reports.

Reconnecting doesn't restart anything. Steps already running on the old
connection fail, and runs that start afterwards use the new one.

Scarn doesn't retry these failures automatically, whatever the step's `retry`
says. Changes the failed attempt already made in Notion may remain, and a new
attempt you start may repeat them.

## Reconnect within 180 days

The card shows **Reconnect by** a date 180 days after the connection was
authorized. Reconnect before that date to keep the connection usable.

### Why a connection can need reconnecting sooner

The access Notion grants lasts a short time, so Scarn renews it with Notion
when it's next needed. If a renewal goes wrong, the connection shows **Reconnect required**
with "Notion stopped accepting this connection. Reconnect to keep using it."
That happens when:

- Notion refuses the renewal, for example because Scarn was removed in
  Notion's connections settings;
- Notion has a server error during the renewal;
- Notion doesn't answer in time, so Scarn can't tell whether the renewal
  happened.

Scarn never retries a renewal it can't confirm; reconnecting is the safe way
back. A connection left unused does nothing in the meantime; it is renewed
only when something needs it.

Reconnecting runs the same three steps. The current connection keeps working
until you confirm the new one, and the confirm card shows what changed, such
as a different account or workspace. If Notion doesn't say which account
signed in, the card says it can't verify that it's the same account.

## See what uses the connection

Before disconnecting or confirming a reconnect, **Used by** lists the latest
active step definitions that reference the connection and their pipelines.
It also counts distinct open runs affected by the change: those running steps
will fail and won't retry automatically. These aren't counts of Notion calls
or a history of every saved step version. Running counts may remain stale
until cleanup catches up.

## Disconnect

**Disconnect** does two things:

1. It deletes Scarn's copy of the connection's access straight away. Steps in
   the project can no longer act in Notion through it.
2. It sends Notion one request to revoke that access, and shows what Notion
   said:

| Outcome         | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| **Accepted**    | Notion accepted the request.                             |
| **Failed**      | Notion refused the request.                              |
| **Unconfirmed** | Notion didn't answer, so Scarn can't tell what happened. |

The connection card keeps showing the latest retained revocation outcome and
a link to remove Scarn in Notion's connections settings. The history is kept
for 30 days; starting a fresh connect clears the displayed outcome.
**Accepted** means only that Notion accepted the request, not that revocation
is confirmed.

### What disconnect doesn't promise

- **That Notion revoked the access.** Even "accepted" is Notion's answer to
  the request, not a guarantee. To be sure, remove Scarn in
  [Notion's connections settings](https://www.notion.so/profile/integrations).
- **That copies in backups are gone.** Disconnect deletes the live copy. It
  doesn't claim anything about backups.
- **That earlier connections were revoked.** When you reconnect, Scarn deletes
  its copy of the replaced connection but sends Notion nothing. The same goes
  for a connection you cancel. Those stay valid at Notion until they expire or
  you remove them in Notion's connections settings.

## Privacy

Connecting Notion means Notion data about the connection is processed and
stored on Scarn's servers:

- **Access tokens** are stored encrypted on Scarn's servers. They never reach
  workers, agents, logs or your browser.
- **Identity**, the Notion user and workspace names and IDs, is encrypted at
  rest. It is kept while the connection is in use and for at most 30 days
  after it's replaced or disconnected.
- **Audit events** record who connected, confirmed, reconnected or
  disconnected, and when. They contain no tokens or identity, and are kept for
  30 days.

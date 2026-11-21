---
title: Connect from the CLI
description: Sign a project's MCP connection in from your terminal, for a listed service or for any remote server in your MCP config
---

`scarn connections connect <name>` signs a project's MCP connection in from
your machine. The CLI opens your browser, catches the service's sign-in
redirect on `127.0.0.1` or `localhost`, and passes it to Scarn. Scarn finishes
the sign-in and keeps the access on its servers, as it does for a connection
made in settings. The CLI never sees a token.

The result is an ordinary connection. It has a card in **MCP connections**,
steps use it with `auth: { connection: "<name>" }`, and runs reach it through
Scarn. See [MCP connections](/scarn/connections/) for names, labels and the
one-connection-per-URL rule, and
[`scarn connections`](/scarn/reference/cli/#scarn-connections) for every flag.

Use the CLI when:

- the server isn't one of the [services you can connect](/scarn/connections/#services-you-can-connect)
  from settings, but is a remote server in your repository's MCP config;
- the server only lets known apps sign in, so you supply a client ID, as
  [Slack](/scarn/connections/slack/) does;
- you'd rather stay in the terminal.

## Before you start

- You need `secrets:write` in the project (see
  [Project secrets](/scarn/guides/secrets/#save-a-secret)).
- Sign in to Scarn with `scarn auth login`. The CLI uses the same sign-in as
  every other command.
- Run the command inside the repository, so it can find the project
  (`project` in `.scarn/scarn.jsonc`, or pass `--project <owner/slug>`) and
  your MCP config.
- Run it on the machine whose browser you'll sign in with. The redirect goes
  to that machine.

## Which client signs in

A service only lets known apps (OAuth clients) sign in. There are three ways
Scarn gets one:

| Case                       | Client ID                                                                                               | Redirect the CLI listens on                                   | Examples                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Server lets Scarn register | Scarn registers its own, with a client ID metadata document (CIMD) or dynamic client registration (DCR) | `http://127.0.0.1:<port>/callback`, on a free port            | Linear and Notion (CIMD); Netlify and Stripe (DCR) |
| A borrowed published app   | `oauth.clientId` in your MCP config, from another tool's app                                            | The one that app is registered with, such as `localhost:3118` | Slack, with another MCP client's app               |
| An app your workspace owns | `oauth.clientId` in your MCP config                                                                     | Whatever you registered for it                                | An internal Slack app                              |

For the last two, Scarn signs in as that app:

:::caution
A connection with a client ID from your MCP config acts as that app. The
service sees every request from the connection as coming from it.
:::

Scarn ships no client IDs of its own for this, and never uses a client secret.
The client must be a public one that signs in without a secret; if it isn't,
the sign-in fails when Scarn exchanges the code.

## Connect a service from the list

```bash
scarn connections connect linear
```

`<name>` is a service's name from
[the list](/scarn/connections/#services-you-can-connect), and becomes the
connection's name. To give the connection another name, pass the service with
`--preset`:

```bash
scarn connections connect issues --preset linear
```

## Connect a server from your MCP config

Add the server to your repository's MCP config, then connect it by its key:

```bash
scarn connections connect my-server
```

The CLI reads the same MCP config files as
[repository references](/scarn/guides/steps/#referencing-a-server-from-your-repository),
such as `.opencode/opencode.jsonc` and `.mcp.json`. The entry must be a remote
server with a literal `url`; a `url` that reads `{env:…}` is refused. These
`oauth` keys are used, in OpenCode's and Claude's formats:

| Key                  | Meaning                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `oauth.clientId`     | Sign in as this app instead of letting Scarn register one. Needs `callbackPort` or `redirectUri`.         |
| `oauth.callbackPort` | The app's redirect is `http://localhost:<callbackPort>/callback` (Claude's format).                       |
| `oauth.redirectUri`  | The app's redirect, used as given. It must be `http` on `localhost`, `127.0.0.1` or `[::1]`, with a port. |
| `oauth.scope`        | The scopes to ask for, separated by spaces. Without it, Scarn asks for every scope the server advertises. |

Any other keys, such as a client secret, are ignored.

### How `<name>` is resolved

1. With `--preset <key>`, the service `<key>`, whatever your MCP config says.
2. Otherwise, a remote server named `<name>` in your MCP config. If that entry
   has no `oauth.clientId` and no `oauth.scope`, and its URL is a listed
   service's, it connects as that service.
3. Otherwise, the service named `<name>`.

Anything else fails with a message naming the services you can use.

### Check the server before anything is stored

For a server from your MCP config, Scarn first checks how it signs in, without
storing anything. The CLI shows:

- the server's URL and the authorization server it signs in with (its issuer);
- the origins of the sign-in and token endpoints;
- any adjustments Scarn needs because the server doesn't follow the MCP
  authorization spec, such as endpoints on another origin, with a warning;
- which client signs in: Scarn's own (with CIMD or DCR), or the client ID from
  your MCP config;
- the scopes it will ask for;
- that anyone who can run steps in the project will be able to act as this
  account.

It then asks `Continue?`. Scarn stores the connection only if the server still
signs in with the same authorization server when you start. A server that lets
Scarn register neither way, with no `oauth.clientId`, can't be connected: add a
client ID to your MCP config.

## Sign in and confirm

The CLI opens your browser at the service's sign-in page. Pass `--no-browser`
to print the URL instead; it's also printed when the browser can't be opened.
Sign in and approve access. The tab then says you can close it.

You have 5 minutes before the CLI stops waiting, and the service's sign-in
expires after 10 minutes either way. Ctrl-C cancels.

Back in the terminal, the CLI shows the account (or that the service didn't
fully identify it), the scopes the service granted, any scopes it asked for
that weren't granted, and this warning:

:::caution
Anyone who can run steps in this project will be able to act in the service as
this account.
:::

It then asks `Make this connection available to every step in <owner/slug>?`.
Nothing is connected until you answer yes. Answering no, or pressing Ctrl-C at
this question, discards the sign-in.

`--yes` answers both questions for you. Without a terminal to ask in, such as
in a script, the command fails unless you pass `--yes`.

## Ports

The CLI listens for the redirect only while you sign in, and only on your own
machine.

- **Servers that let Scarn register** get a free port the system picks, on
  `127.0.0.1`. The OAuth spec for native apps lets the port of a loopback
  redirect vary, so one registration serves every sign-in. A CIMD server that
  refuses a varying port fails the sign-in on its own page.
  <!-- TODO(phase-10): record whether Linear (CIMD) honours loopback port variance, and say so here. -->
- **If a DCR server refuses a varying port,** Scarn registers fixed port
  `28418` with it once, and the CLI listens there for that server from then
  on. <!-- TODO(phase-10): record whether Netlify needed the fixed-port fallback, and say so here. -->
- **A client ID from your MCP config** has one fixed redirect, from
  `oauth.callbackPort` or `oauth.redirectUri`. The CLI listens on exactly that
  host and port.

If the port is already in use, the command fails with
`loopback_port_in_use` and names the port. For a fixed port, stop whatever is
using it, such as the tool the app belongs to, and try again.

## Scopes

A connection's scopes are fixed when it's created: later connects and
reconnects ask for the same ones. They come from `--scope` (repeat it for more)
or, without it, from `oauth.scope` in your MCP config. With neither, Scarn asks
for every scope the server advertises.

`--scope` only applies to a server from your MCP config. A listed service always
asks for the scopes its server advertises, so `--scope` with one is refused.

## Reconnect

```bash
scarn connections reconnect linear
```

Reconnecting signs the existing connection in again, with the same client and
scopes, and asks you to confirm in the same way. The current
connection keeps working until you confirm the new sign-in. `scarn connections
list` shows each connection's name and state.

A connection whose client ID comes from your MCP config can only be signed in
again from the CLI, because its redirect is on your machine. Its card in
settings has no **Reconnect** button, and says
"Reconnect from the CLI: `scarn connections reconnect <name>`". Other
connections can be reconnected either way. A connection to a server from your
MCP config has no **Connect** button in settings either; after disconnecting
it, run `scarn connections connect <name>` again.

## In settings

A connection made from your MCP config shows "Connected from the CLI · Signs in
with _issuer_" on its card. Otherwise it's managed like any other: the card
shows its state, account, scopes and tools, and **Disconnect** works the same.

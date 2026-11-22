---
title: Use the CLI with your server
description: Point scarn auth, scarn init and workers at a self-hosted Scarn server
---

The `scarn` CLI talks to `https://api.scarn.io` unless you tell it otherwise.
Point it at your install with the web app's public URL, the same value as
`APP_URL`. The web app serves the API under `/api`, so the CLI, workers and
browsers all use that one URL.

## Choose the server

Every command that talks to the server takes `--base-url`:

```bash
scarn auth login --base-url https://scarn.example.com
scarn init --base-url https://scarn.example.com
```

To avoid repeating it, set `SCARN_BASE_URL` in your shell profile, or in a
`.scarn.env` (or `.env`) file in the directory you run `scarn` from:

```bash
export SCARN_BASE_URL=https://scarn.example.com
scarn auth login
scarn init
```

The CLI uses `--base-url` first, then `SCARN_BASE_URL`, then
`https://api.scarn.io`. A trailing slash is ignored.

Browser links that `scarn init` prints or opens go to `--app-url`, then
`SCARN_APP_URL`, then the server URL above. You only need `--app-url` if the
web app lives at a different address from the API.

## Sign in

`scarn auth login` uses the device flow: it prints a code, opens
`<APP_URL>/cli-auth` in your browser, and waits while you sign in and
approve it. Nothing has to be registered on the server first. The CLI
identifies itself as the built-in client `scarn-cli`, which every Scarn
server accepts. Sign in with whatever the login page offers, such as
[email and password](/scarn/self-hosting/quickstart/#sign-in).

If the browser opens the hosted app or the wrong host, check that `APP_URL`
in `.env.selfhost` is your public URL. The server builds the approval link
from it.

Credentials are saved to `~/.scarn/auth.jsonc`, one profile per server URL.
Signing in to your server doesn't sign you out of the hosted app. Check or
remove a profile with the same URL:

```bash
scarn auth status --base-url https://scarn.example.com
scarn auth logout --base-url https://scarn.example.com
```

## Set up a project

Run `scarn init` in your repository with the same URL. It creates or links a
project on your server and writes `.scarn/scarn.jsonc`:

```bash
scarn init --base-url https://scarn.example.com
```

Project commands such as `scarn tasks`, `scarn runs` and `scarn work-items`
take `--base-url` too, or pick up `SCARN_BASE_URL`.

## Workers

`scarn work` and `scarn worker start` accept `--base-url`. A worker
remembers the server it was first started for and refuses to start against a
different one with `worker_base_url_mismatch`, so start it with your
server's URL from the beginning. See [Workers](/scarn/guides/workers/).

Workers download and upload logs and artifacts directly from object storage
through presigned URLs, so the machine running the worker must reach
`S3_ENDPOINT` as well as the web app.

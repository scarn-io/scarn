---
title: Run the demo project
description: Seed the read-only demo project on a self-hosted install, link to it from the app, and keep it fresh
---

Scarn ships a read-only demo project at `/scarn/demo`: a seeded work item with
captured agent runs, logs and artifacts that visitors can look around without
signing in. A self-hosted install doesn't have it unless you seed it, and the
app only links to it when you turn it on.

## Seed it

From `apps/api`, with `DATABASE_URL` and your object storage (`S3_*`) settings
in the repo-root `.env`:

```bash
bun run seed:demo-project
```

The script is safe to run again: it updates the demo pipelines to match the
fixtures and only creates work items and executions that are missing. To
delete the demo project's executions and seed fresh ones, pass
`--reset` (or run `bun run seed:demo-project:reset`):

```bash
bun run seed:demo-project --reset
```

The script refuses to run when `DATABASE_URL` and the object store point at
different environments: a `localhost` database with no `S3_ENDPOINT` (real
AWS S3), or a remote database with `S3_ENDPOINT` set (local RustFS or
LocalStack). That mismatch usually means you exported one variable in your
shell and the other fell back to `.env`, which would write database rows that
point at log and artifact files in the wrong bucket. Load one consistent set
of variables for the install you mean to seed. If `S3_BUCKET` is unset, the
check is skipped.

## Link to it from the app

Set this on the Next.js app's server environment:

```bash
SCARN_DEMO_PROJECT=true
```

`true` or `1` turns it on; anything else, or leaving it unset, turns it off.
When it's on, the sign-in page shows "See the demo project" and the empty
projects dashboard links to it. The app reads the setting at request time, so
you can change it without rebuilding.

Turn it on only after seeding. The demo project's own pages (its tour and
banner) work whenever the project exists, whatever this setting says.

## Keep it fresh

Archived step logs expire after 30 days, the same as in any project. The
refresh route resets and reseeds the demo project so its logs stay readable:

```
POST /api/internal/demo-project/refresh
Authorization: Bearer <DEMO_PROJECT_REFRESH_CRON_SECRET>
```

Set `DEMO_PROJECT_REFRESH_CRON_SECRET` on the API (for example
`openssl rand -hex 32`) and call the route on a schedule shorter than 30 days,
for example from cron:

```bash
curl -X POST https://scarn.example.com/api/internal/demo-project/refresh \
  -H "Authorization: Bearer $DEMO_PROJECT_REFRESH_CRON_SECRET"
```

The route fails closed: without the secret it returns a 500, and a wrong or
missing token returns a 401.

## The `scarn` username is reserved

An identity migration creates the demo account's user, `scarn`, on every
install, whether or not you seed the demo project. Nobody else can sign up
with that username.

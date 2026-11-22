---
title: Self-hosting quickstart
description: Run the Scarn server on your own machine with Docker Compose
---

Scarn's server is the API, the web app, a Postgres database and S3-compatible
object storage. `docker-compose.selfhost.yml` at the root of the repository
runs all of it, plus a one-shot migration step and a scheduler for the
maintenance jobs. It doesn't need Vercel, AWS or Cloudflare.

## Before you start

You need Docker with Compose v2 and a clone of the repository:

```bash
git clone https://github.com/scarn-io/scarn.git
cd scarn
```

Create `.env.selfhost` next to the compose file. Every service reads its
settings from it. See [Configuration](#configuration).

## Start it

```bash
docker compose -f docker-compose.selfhost.yml up -d
```

Compose pulls the published images (`ghcr.io/scarn-io/scarn-api` and
`ghcr.io/scarn-io/scarn-next`), starts the database and storage, creates the
bucket, runs migrations, and then starts the API, the web app and the
scheduler. Open the web app at `http://localhost:3000`, or at whatever
`APP_URL` you put in front of it.

To pin a release instead of `latest`, set `SCARN_VERSION`:

```bash
SCARN_VERSION=v1.2.3 docker compose -f docker-compose.selfhost.yml up -d
```

To build the images from your checkout instead of pulling them:

```bash
docker compose -f docker-compose.selfhost.yml build
```

## What runs

| Service        | What it does                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `db`           | Postgres 17 with pgvector. Data lives in the `postgres_data` volume.                                                                  |
| `storage`      | [RustFS](https://rustfs.com), an S3-compatible object store for logs, artifacts and task sessions. Published on port 9100 by default. |
| `storage-init` | One-shot: creates the bucket, sets the 30-day expiry rules and allows the web app to download from it.                                |
| `migrate`      | One-shot: applies the database migrations. Runs on every `up`.                                                                        |
| `api`          | The standalone API, on port 3001 by default. The web app and the scheduler call it.                                                   |
| `next`         | The web app, on port 3000 by default. It also serves the API under `/api`, so browsers, workers and the CLI only need this one URL.   |
| `scheduler`    | Calls the API's maintenance routes on a schedule.                                                                                     |
| `work-signal`  | Optional. Wakes idle workers and streams live logs. See [Work signal](#work-signal-optional).                                         |

Change the published ports with `SCARN_WEB_PORT`, `SCARN_API_PORT`,
`SCARN_STORAGE_PORT` and `SCARN_WORK_SIGNAL_PORT` in your shell or in a
`.env` file next to the compose file.

Put your reverse proxy and TLS in front of `next`. Browsers and workers
download and upload files through presigned URLs built from `S3_ENDPOINT`,
so it has to be an address they can reach, not just the containers. Use a
public hostname for the storage service, or this machine's address and the
published port.

## Scheduled jobs

The `scheduler` service POSTs these API routes with
`Authorization: Bearer <secret>`. Times are UTC.

| Job                       | Route                                            | When                                           | Secret                             |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------- | ---------------------------------- |
| Storage reconciliation    | `/api/internal/usage/reconcile-storage`          | Daily 08:00                                    | `RECONCILE_CRON_SECRET`            |
| Abandoned-log cleanup     | `/api/internal/executions/purge-abandoned-logs`  | Daily 08:30                                    | `RECONCILE_CRON_SECRET`            |
| Deleted-storage sweep     | `/api/internal/executions/sweep-deleted-storage` | Daily 09:00                                    | `RECONCILE_CRON_SECRET`            |
| Managed-connections sweep | `/api/internal/connections/sweep`                | Daily 09:30                                    | `RECONCILE_CRON_SECRET`            |
| GitHub reconciliation     | `/api/internal/integrations/reconcile`           | Daily 10:00                                    | `GITHUB_RECONCILE_CRON_SECRET`     |
| Integration auto-sync     | `/api/internal/integrations/poll`                | Every 10 minutes 13:00–23:50, hourly otherwise | `INTEGRATION_POLL_CRON_SECRET`     |
| Demo project refresh      | `/api/internal/demo-project/refresh`             | 04:00 on the 1st and 15th                      | `DEMO_PROJECT_REFRESH_CRON_SECRET` |

The API and the scheduler read the same `.env.selfhost`, so they always
agree on the secrets. Generate each one with `openssl rand -hex 32`. When a
secret is unset, the scheduler skips that job and logs why at startup. The
demo project refresh also needs `SCARN_DEMO_PROJECT=true`; see
[Run the demo project](/scarn/self-hosting/demo-project/).

Check what the scheduler picked up:

```bash
docker compose -f docker-compose.selfhost.yml logs scheduler
```

## Work signal (optional)

Without it, idle `scarn work` workers poll for new work and live logs go
through Postgres. With it, workers wake up as soon as work is queued and logs
stream over WebSockets. Start it with the `work-signal` profile:

```bash
docker compose -f docker-compose.selfhost.yml --profile work-signal up -d
```

Then set `WORK_SIGNAL_URL`, `WORK_SIGNAL_NOTIFY_SECRET`,
`WORK_SIGNAL_TOKEN_SECRET`, `LOG_FEED_URL`, `LOG_FEED_INTERNAL_SECRET` and
`LOG_FEED_TOKEN_SECRET` in `.env.selfhost` and restart `api` and `next`.
Workers and browsers connect to `WORK_SIGNAL_URL` and `LOG_FEED_URL`
directly, so like `S3_ENDPOINT` they must be reachable from outside Docker.
The service runs `wrangler dev`, the same way development does.

## Upgrade

Pull the new images and start again. The `migrate` step applies any new
migrations before the API starts:

```bash
docker compose -f docker-compose.selfhost.yml pull
docker compose -f docker-compose.selfhost.yml up -d
```

If you pin `SCARN_VERSION`, change it first. Back up the `postgres_data`
volume before upgrading across releases.

## Configuration

All settings go in `.env.selfhost`. Start from the template at the root of
the repository, which lists every variable with a one-line description:

```bash
cp .env.selfhost.example .env.selfhost
```

Replace every `change-me`. The API and the scheduler check their required
variables at startup and exit with a message that names every missing one,
so `docker compose -f docker-compose.selfhost.yml logs api` tells you what's
left.

### Required

| Variable                                            | What it is                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Credentials the `db` container is created with.                                                                         |
| `DATABASE_URL`                                      | Postgres connection string. Use the values above with host `db` and port 5432.                                          |
| `SECRETS_ENCRYPTION_KEY`                            | Encrypts saved secrets at rest. Base64 of exactly 32 bytes: `openssl rand -base64 32`.                                  |
| `BETTER_AUTH_SECRET`                                | Signs sessions and tokens: `openssl rand -hex 32`.                                                                      |
| `BETTER_AUTH_URL`, `APP_URL`                        | The public URL of the web app, without a trailing slash. Both get the same value.                                       |
| `S3_BUCKET`                                         | The bucket `storage-init` creates.                                                                                      |
| `S3_ENDPOINT`                                       | The storage URL. It must be reachable from browsers and workers as well as the containers; see [What runs](#what-runs). |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`          | The storage root user, which the API also signs in with.                                                                |
| `RECONCILE_CRON_SECRET`                             | Bearer secret for the storage and log maintenance jobs. The scheduler won't start without it.                           |

Keep `S3_REGION=us-east-1` and `S3_FORCE_PATH_STYLE=true` for the bundled
RustFS. To use another S3-compatible store or AWS S3, point `S3_ENDPOINT`
and the credentials at it; you then create the bucket and its CORS rules
yourself.

### Optional

| Variable                                                                                           | What it turns on                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_EMAIL_PASSWORD_LOGIN`                                                                      | Email/password sign-in. On unless set to `false`; see [Sign-in](#sign-in).                                             |
| `GITHUB_APP_*`                                                                                     | Sign in with GitHub and App-based GitHub integrations. See [Use your own GitHub App](/scarn/self-hosting/github-app/). |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`                                             | Sign in with Google.                                                                                                   |
| `BETTER_AUTH_TRUSTED_ORIGINS`                                                                      | Extra comma-separated origins allowed to call the auth endpoints.                                                      |
| `BETTER_AUTH_APP_NAME`                                                                             | The app name the auth layer uses. Defaults to `Scarn`.                                                                 |
| `PLATFORM_ADMIN_EMAILS`                                                                            | Comma-separated emails allowed to use platform-operator routes.                                                        |
| `GITHUB_RECONCILE_CRON_SECRET`, `INTEGRATION_POLL_CRON_SECRET`, `DEMO_PROJECT_REFRESH_CRON_SECRET` | The other [scheduled jobs](#scheduled-jobs).                                                                           |
| `SCARN_DEMO_PROJECT`                                                                               | Links to the read-only demo project. See [Run the demo project](/scarn/self-hosting/demo-project/).                    |
| `SCARN_DEFAULT_PLAN`                                                                               | The plan new organizations start on. Unset means unlimited.                                                            |
| `POSTHOG_API_KEY`, `POSTHOG_HOST`                                                                  | Server-side product analytics. Off while unset.                                                                        |
| `WORK_SIGNAL_*`, `LOG_FEED_*`                                                                      | The [work signal](#work-signal-optional) service.                                                                      |

`SCARN_VERSION` and the `SCARN_*_PORT` variables are read by Compose itself,
so they go in your shell or a `.env` file, not in `.env.selfhost`.

### Sign-in

Self-hosted installs don't need an OAuth provider. Email/password sign-in is
on by default: the login page shows an email form, and anyone who can reach
it can create an account. Scarn has no mail transport, so addresses aren't
verified and there's no password reset email. Keep the web app on a private
network or behind your proxy's access control if you don't want open sign-up.

To sign in with GitHub, [create your own GitHub App](/scarn/self-hosting/github-app/)
and set its client ID and secret. To sign in with Google, create an OAuth web
client with the redirect URI `<BETTER_AUTH_URL>/api/auth/callback/google` and
set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Once at least
one of them is set you can turn the email form off with
`ENABLE_EMAIL_PASSWORD_LOGIN=false`.

A GitHub or Google sign-in doesn't join an existing email/password account
with the same address, because that address was never verified. Sign in the
way you signed up.

### Connect the CLI

Point `scarn auth login` and `scarn init` at your web app's URL with
`--base-url` or `SCARN_BASE_URL`. See [Use the CLI with your server](/scarn/self-hosting/cli/).

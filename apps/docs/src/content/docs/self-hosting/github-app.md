---
title: Use your own GitHub App
description: Create a GitHub App for a self-hosted install to sign in with GitHub and sync issues through webhooks
---

The hosted Scarn uses its own GitHub App. A self-hosted install can't share
it, so if you want **Sign in with GitHub** or
[GitHub App integrations](/scarn/how-to/integrations/#connect-the-github-app),
you create an App of your own and give Scarn its credentials.

You don't need one to use Scarn. Without it, people sign in with
[email and password](/scarn/self-hosting/quickstart/#sign-in) (or Google),
and these integrations work as they do on the hosted app:

- [GitHub with a token](/scarn/how-to/integrations/#connect-github-with-a-token)
- Bitbucket
- Jira

## Create the App

In the examples below, `https://scarn.example.com` is your `BETTER_AUTH_URL`,
the public URL of the web app.

Open **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
([github.com/settings/apps/new](https://github.com/settings/apps/new)). To
create it under an organization, use the organization's settings instead.
Fill in:

| Field                                                  | Value                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| GitHub App name                                        | Anything unique on GitHub, such as `scarn-acme`              |
| Homepage URL                                           | `https://scarn.example.com`                                  |
| Callback URL                                           | `https://scarn.example.com/api/auth/callback/github`         |
| Expire user authorization tokens                       | Leave it on                                                  |
| Request user authorization (OAuth) during installation | Off                                                          |
| Setup URL                                              | `https://scarn.example.com/api/integrations/github/callback` |
| Redirect on update                                     | On                                                           |
| Webhook → Active                                       | On                                                           |
| Webhook URL                                            | `https://scarn.example.com/api/integrations/github/webhook`  |
| Webhook secret                                         | A random string: `openssl rand -hex 32`                      |

GitHub must be able to reach the webhook URL. On a private network, leave
the webhook inactive: the daily reconciliation
[scheduled job](/scarn/self-hosting/quickstart/#scheduled-jobs) still picks up
issue changes, just not within seconds.

### Permissions

| Permission                | Access         | Why                                                          |
| ------------------------- | -------------- | ------------------------------------------------------------ |
| Repository → Issues       | Read and write | Sync issues into work items and post comments you approve    |
| Repository → Metadata     | Read-only      | Required by GitHub; lists the repositories an install covers |
| Account → Email addresses | Read-only      | Sign in with GitHub reads the verified email                 |

If you never post comments from Scarn, **Issues: Read-only** is enough.

### Events

Subscribe to **Issues**. GitHub always sends the installation events, which
Scarn uses to unlink repositories when the App is uninstalled or loses access
to them.

### Where it can be installed

Choose **Only on this account** to keep the App to your own user or
organization, or **Any account** if people will install it on other
organizations.

## Collect the credentials

After **Create GitHub App**, on the App's settings page:

1. Note the **App ID** and the **Client ID**.
2. The slug is the last part of the App's public URL,
   `https://github.com/apps/<slug>`.
3. Under **Client secrets**, click **Generate a new client secret**.
4. Under **Private keys**, click **Generate a private key**. GitHub downloads
   a `.pem` file.

## Configure Scarn

Add these to `.env.selfhost`:

| Variable                    | Value                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| `GITHUB_APP_ID`             | The App ID                                                              |
| `GITHUB_APP_SLUG`           | The slug                                                                |
| `GITHUB_APP_PRIVATE_KEY`    | The contents of the `.pem` file on one line, with `\n` for each newline |
| `GITHUB_APP_WEBHOOK_SECRET` | The webhook secret you chose                                            |
| `GITHUB_APP_CLIENT_ID`      | The Client ID                                                           |
| `GITHUB_APP_CLIENT_SECRET`  | The client secret                                                       |

To turn the key file into one line:

```bash
awk 'NF {printf "%s\\n", $0}' scarn-acme.*.private-key.pem
```

Also set `GITHUB_RECONCILE_CRON_SECRET` so the daily reconciliation runs. Then
restart the services that read them:

```bash
docker compose -f docker-compose.selfhost.yml up -d api next scheduler
```

The login page now shows **Continue with GitHub**, and **Settings →
Integrations → Connect GitHub** installs your App.

`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` alone turn on GitHub
sign-in. The App ID, slug and private key turn on App integrations. The
webhook secret turns on instant updates; without it, the webhook route
answers `503` and changes arrive with the next sync.

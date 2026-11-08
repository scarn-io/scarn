# ADR 0001: Containers get git credentials through a per-run relay, on by default; push stays on the host

**Status:** Accepted. November 2026. Revised November 2026: on by default,
with the worker owner holding the switch (see "Revision: why on by default").

**Plan:** `docs/plans/git-credential-relay.md` (decisions 1, 3, 9 and 14, and
the "Revision (November 2026): on by default" section).

## Context

Git running inside a Task's devcontainer has no credentials, so private
submodules in `postCreateCommand`, private git dependencies in a package
install, or a `git fetch` the agent runs all fail. Users would otherwise copy
tokens into `.scarn/.env` or their devcontainer config. Meanwhile the worker
already commits and pushes the work branch, submodules included, from the host
with the host's own git credentials.

We want container git to fetch private repositories without tokens in user
config, without editing the user's gitconfig, and with a place to swap in a
narrower credential source (a short-lived, read-only GitHub App installation
token on managed workers) later.

## Decision

1. **Push stays on the host.** The container only needs to fetch. The worker
   keeps committing and pushing the work branch and submodules itself.
2. **On by default; the worker owner consents.** The worker setting
   `SCARN_GIT_CREDENTIALS=on|off` (default `on`) decides whether the relay
   runs at all. A step can opt out with `repo.gitCredentials: "none"`; the
   default is `"auto"`, meaning "use the worker's relay if it is on".
3. **The worker side is layered like provider access.** An in-container
   credential helper (`git-credential-scarn`, POSIX `sh` over `curl` or
   `wget`) posts git's request to a per-Task-run relay server
   (`CredentialRelayServer`, bearer-token protected). `CredentialRelay`
   parses the request, applies `GitCredentialPolicy` (HTTPS only, allowed
   hosts only), asks a `GitCredentialSource` port, registers the issued
   password with the log masker and audits the request. The worker env picks
   the source (`SCARN_GIT_CREDENTIAL_SOURCE`): `host` runs
   `git credential fill` on the worker; `api` is a declared seam for an
   API-minted token. This mirrors `ProviderAccessResolver`
   (`direct` / `brokered`). Code in
   `packages/worker/src/runtime/git-credentials/`.
4. **Read-only is enforced by the source, not the relay.** Git's credential
   protocol does not say whether a request is for a fetch or a push, so the
   relay can't tell. The `host` source returns whatever the host has, which
   may be able to push. The container env sets
   `url.scarn-push-disabled://.pushInsteadOf=https://` so a plain `git push`
   fails, but that is a guardrail against accidents, not a boundary. A real
   read-only guarantee comes from a source that mints read-only tokens (the
   future `api` source, `contents: read`, enforced by GitHub).
5. **Known limitation: the token is visible to the agent.** Anything in the
   container can run `git credential fill` and read the credential. We accept
   this for now. A git smart-HTTP proxy (`url.<relay>.insteadOf`, refusing
   `git-receive-pack`) could replace the helper behind the same session,
   policy and source without changing step config.
6. **Degrade, don't fail.** Where the relay can't be wired in cleanly (a
   compose-based devcontainer, or a `containerEnv` that already sets
   `GIT_CONFIG_COUNT`), the worker skips it with one task-log line and the
   launch continues. The Scarn helper is added without resetting
   `credential.helper`, so the user's own helpers run first, and the
   SSH→HTTPS rewrites are skipped when `containerEnv` sets `SSH_AUTH_SOCK`.

## Revision: why on by default

The first version made it a per-step opt-in, `gitCredentials: "read"`,
default `"none"`. We changed that:

- **Bias toward enabling agents.** Steps that hit a private submodule or git
  dependency failed until someone found the setting. Working by default is
  the better first experience, and opting out is one line.
- **The worker owner holds the switch.** The credential being shared is the
  worker host's, so its owner, not the step author, is who consents.
  `SCARN_GIT_CREDENTIALS=off` turns it off for every step on that worker.
  Step authors can still turn it off per step with `"none"`.
- **The step value names no permission.** `"read"` promised something the
  `host` source can't enforce. `"auto"` says only "use what the worker
  offers", which stays true for the `host` source and for future sources
  (more values, such as a GitHub App source on hosted workers, may be added).

## Consequences

- By default, every `readOnly` / `readWrite` step's container can obtain the
  worker host's git credential for the allowed hosts, and with the `host`
  source that credential may be able to push. Worker owners who don't want
  that set `SCARN_GIT_CREDENTIALS=off`; step authors set
  `Repo.readOnly({ gitCredentials: "none" })` or
  `Repo.readWrite({ gitCredentials: "none" })`.
- With the switch off, a step set to `"none"`, or a dry run, the step
  launches with an unchanged devcontainer.json.
- Switching to the `api` source needs no change to step definitions, the
  helper or the container env. Until it is built, selecting it fails at worker
  start.
- Every request is audited in the task log without secrets, and issued
  passwords are masked.
- Compose-based devcontainers and devcontainers that set `GIT_CONFIG_COUNT`
  get no relay (logged, not an error). Containers without `curl` or `wget`
  get no credentials, and git fails as it would without them.

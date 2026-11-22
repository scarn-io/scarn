# AGENTS.md

Scarn is a Bun-workspace monorepo (no git submodules). It holds the Scarn
server (API, Next.js UI, DDD core) and the client-facing CLI, SDK, worker and
OpenCode plugin.

This repository is synced from a private repository. Pull requests are welcome
and are ported to it by hand, with credit.

## Layout

- `apps/api` — Elysia HTTP API. All routes live in `apps/api/src/http/routes/`
  and are mounted under `/api`.
- `apps/next` — Next.js UI.
- `apps/cli` — the `scarn` CLI.
- `apps/docs` — documentation site (Astro Starlight).
- `apps/work-signal` — optional Cloudflare Worker (Durable Objects) that
  pushes work signals and live Task logs to workers and browsers.
- `packages/core` — domain and application logic (DDD, see below).
- `packages/identity` — authentication (Better Auth), sessions, access JWTs.
- `packages/worker` — runs Tasks on a machine; used by the CLI.
- `packages/sdks` — the TypeScript SDK (`@scarn/sdk`).
- `packages/opencode-plugin`, `packages/containers`, `packages/observability`,
  `packages/shared-core`, `packages/design-tokens`,
  `packages/pipeline-studio-ui`, `packages/local-dev` — supporting packages.

## `packages/core` layout

- `src/<domain>/<aggregate>/` with layers `contracts/` (Zod schemas and
  types), `application/` (use cases and ports), `domain/` (entities, value
  objects, invariants) and `infra/` (Drizzle repos and adapters).
- Application code depends on ports, never on `infra/`. Wiring happens in
  `src/lib/di.ts`.
- Tests live in `packages/core/tests/<domain>/<aggregate>/{unit,integration}/`.
  Integration tests go through the API test client and may not import
  application code (enforced by ESLint); domain-only logic gets unit tests.

## Commands

Run from the repo root:

- `bun install` — install dependencies.
- `bun run typecheck` — typecheck every workspace.
- `bun run lint` — ESLint.
- `bun run db:migrate` — apply database migrations (needs `DATABASE_URL`).
- There is no root `bun test`. Run tests per workspace, e.g.
  `cd packages/core && bun run test:unit`, or `bun test` inside `apps/api`.
  Integration tests start Postgres with testcontainers, so they need Docker.
- Do not run `prettier . --write`; format only the files you touched with
  `bun x prettier --write <paths>`.

## Rules

- Do not add `route.ts` files under `apps/next/app/api/` — all HTTP routes
  live in `apps/api/src/http/routes/` and are mounted under `/api`.
- Prefer clean current-state design over backward-compatibility code.
- Skip inline comments narrating what a line does; write code that reads
  clearly on its own. Top-level doc comments (module/class level) are fine.
- Put new tests next to the existing ones for the package you are changing,
  and keep unit and integration tests in separate files.

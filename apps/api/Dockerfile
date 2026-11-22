# syntax=docker/dockerfile:1.7
#
# Standalone Scarn API (Bun, run straight from TypeScript), plus the
# migration runner and the self-hosted scheduler, which reuse this image with
# a different command (see docker-compose.selfhost.yml).
#
# Build from the repo root:
#   docker build -f apps/api/Dockerfile -t scarn-api .
#
# The image works in both the private monorepo and the public mirror: it copies
# the whole apps/ and packages/ trees rather than naming workspaces, so
# whichever workspaces exist (and match bun.lock) are installed.

ARG BUN_VERSION=1.4.4

# Collect only the package.json files, so the dependency layer below is cached
# until a manifest or the lockfile changes.
FROM oven/bun:${BUN_VERSION}-slim AS manifests
WORKDIR /src
COPY apps ./apps
COPY packages ./packages
RUN find apps packages -mindepth 1 -type f ! -name package.json -delete \
  && find apps packages -mindepth 1 -type d -empty -delete

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY --from=manifests /src/apps ./apps
COPY --from=manifests /src/packages ./packages
# Lifecycle scripts are skipped: the API and its migrations need none. The root
# workspace (`./`) is included because scripts/db-migrate.ts imports `pg` from
# the root devDependencies; drizzle-kit comes from core and identity.
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts \
    --filter ./ --filter @scarn/api --filter @scarn/core --filter @scarn/identity

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
  PORT=3001
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY scripts/db-migrate.ts ./scripts/db-migrate.ts
COPY apps ./apps
COPY packages ./packages
USER bun
EXPOSE 3001
WORKDIR /app/apps/api
CMD ["bun", "run", "src/index.ts"]

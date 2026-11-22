# syntax=docker/dockerfile:1.7
#
# Self-hosted Scarn web app: Next.js `output: "standalone"` served by Node.
# The app also serves the API in-process under /api (app/api/[[...slugs]]), so
# browsers talk to it same-origin and no NEXT_PUBLIC_SCARN_API_URL needs to be
# baked in. All other configuration is read at runtime.
#
# Build from the repo root:
#   docker build -f apps/next/Dockerfile -t scarn-next .
#
# Like apps/api/Dockerfile it copies the whole apps/ and packages/ trees, so it
# builds in both the private monorepo and the public mirror.

ARG BUN_VERSION=1.4.4
ARG NODE_VERSION=22

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
# `--filter ./` adds the root workspace, whose devDependencies provide the
# TypeScript that `next build` needs to load next.config.ts.
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts --filter ./ --filter @scarn/next

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# Optional analytics keys are inlined into the client bundle at build time.
ARG NEXT_PUBLIC_POSTHOG_KEY=""
ARG NEXT_PUBLIC_POSTHOG_HOST=""
ARG NEXT_PUBLIC_POSTHOG_UI_HOST=""
ARG NEXT_PUBLIC_ANALYTICS_COOKIE_DOMAIN=""
ENV NEXT_OUTPUT=standalone \
  NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY} \
  NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST} \
  NEXT_PUBLIC_POSTHOG_UI_HOST=${NEXT_PUBLIC_POSTHOG_UI_HOST} \
  NEXT_PUBLIC_ANALYTICS_COOKIE_DOMAIN=${NEXT_PUBLIC_ANALYTICS_COOKIE_DOMAIN}
WORKDIR /app/apps/next
# Typechecking is CI's job (`bun run typecheck`); skip it here to keep image
# builds fast.
RUN E2E_SKIP_TYPECHECK=1 bun run build

FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000 \
  HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/next/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/next/.next/static ./apps/next/.next/static
COPY --from=build --chown=node:node /app/apps/next/public ./apps/next/public
USER node
EXPOSE 3000
CMD ["node", "apps/next/server.js"]

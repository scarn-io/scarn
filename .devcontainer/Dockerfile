FROM mcr.microsoft.com/devcontainers/base:bookworm

# Node satisfies `#!/usr/bin/env node` shebangs in native install scripts of
# transitive dependencies (e.g. ssh2 -> cpu-features, testcontainers).
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Bun system-wide so both root (build time) and vscode (runtime) can use it.
RUN curl -fsSL https://bun.sh/install | env BUN_INSTALL=/usr/local bash

# Mount point for the `scarn-bun-cache` volume (see devcontainer.json). Docker
# seeds a new named volume with this directory's ownership.
RUN mkdir -p /home/vscode/.bun/install/cache \
    && chown -R vscode:vscode /home/vscode/.bun

# Playwright browsers in a world-readable fixed path. The version must match
# the resolved @playwright/test version in bun.lock.
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/ms-playwright
RUN bun x playwright@1.61.0 install --with-deps chromium \
    && chmod -R a+rX /usr/local/ms-playwright

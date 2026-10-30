#!/usr/bin/env bash
set -e

# Run pack:local, tee all output to stderr so it's visible in the terminal,
# and capture the last stdout line (the artifact path printed by the script).
ARTIFACT_PATH=$(cd packages/sdks/js && bun run pack:local | tee /dev/stderr | tail -1)

bun run --filter @scarn/opencode-plugin build
SCARN_SDK_ARTIFACT_PATH="$ARTIFACT_PATH" bun run --filter @scarn/cli build:dev
# Link as "scarn-dev" (not "scarn") so this doesn't clobber a real scarn
# CLI install on the same machine.
SCARN_CLI_LINK_NAME="scarn-dev" bun run --filter @scarn/cli link

import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@scarn/core": fileURLToPath(
        new URL("../../packages/core/src", import.meta.url),
      ),
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          WORK_SIGNAL_NOTIFY_SECRET: "test-notify-secret",
          WORK_SIGNAL_TOKEN_SECRET: "test-token-secret",
          LOG_FEED_INTERNAL_SECRET: "test-log-feed-internal-secret",
          LOG_FEED_TOKEN_SECRET: "test-log-feed-token-secret",
        },
      },
    }),
  ],
});

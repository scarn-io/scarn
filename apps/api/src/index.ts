import * as analyticsServer from "@scarn/observability/analytics/server";
import { loadSecretCipherFromEnv } from "@scarn/core/secrets/secret/infra/load-secret-cipher-from-env";
// Importing ./app runs initServerAnalytics() at module scope, so the PostHog
// client is live before this process serves its first request.
import { handleRequest } from "./app";
import { API_REQUIRED_ENV, assertRequiredEnv } from "./required-env";

// Fail startup on missing configuration or an invalid SECRETS_ENCRYPTION_KEY
// instead of on the first request that needs it.
try {
  assertRequiredEnv(API_REQUIRED_ENV, "[api]");
  loadSecretCipherFromEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const configuredPort = Number(process.env["PORT"] ?? "3001");

// Long-lived process: drain any queued events on shutdown.
// Flush on shutdown so in-flight timing events aren't lost when the process
// exits (e.g. during dev restarts or deploys).
const shutdownAnalytics = async (): Promise<void> => {
  await analyticsServer.shutdown();
};
process.on("SIGINT", () => {
  void shutdownAnalytics().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdownAnalytics().finally(() => process.exit(0));
});

const server = Bun.serve({
  port: configuredPort,
  fetch: (request) => handleRequest(request),
});

const portText = String(server.port ?? configuredPort);

console.warn(`[api] listening on http://localhost:${portText}`);
console.warn(`[api] openapi ui: http://localhost:${portText}/api/openapi`);
console.warn(
  `[api] openapi json: http://localhost:${portText}/api/openapi/json`,
);

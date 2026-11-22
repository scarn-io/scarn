import * as analyticsServer from "@scarn/observability/analytics/server";
import { getPosthogServerHost, getPosthogServerKey } from "@scarn/identity";

// The PostHog server client MUST be initialized by whatever module actually
// boots the API, because every capture in @scarn/observability/analytics/server is a silent
// no-op while the client is null.
//
// There are two entrypoints and only one of them used to do this:
//   - src/index.ts        — the standalone Bun server (local dev, `bun run api`)
//   - src/app.ts          — imported directly by the Next.js catch-all route
//                           handler (apps/next/app/api/[[...slugs]]/route.ts),
//                           which is how the API runs in production on Vercel
//
// Initializing here and calling it from app.ts covers both, since app.ts is the
// one module every entrypoint loads.
export const initServerAnalytics = (): boolean => {
  // Idempotent: the identity package also initializes lazily inside
  // createIdentityAuth(), and whichever runs first wins.
  if (analyticsServer.isInitialized()) return true;

  const key = getPosthogServerKey();
  const host = getPosthogServerHost();

  if (!key || !host) {
    console.warn(
      "[api] posthog analytics DISABLED: set POSTHOG_API_KEY and POSTHOG_HOST",
    );
    return false;
  }

  analyticsServer.init({ key, host });
  console.warn("[api] posthog analytics enabled");
  return true;
};

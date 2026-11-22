import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as analyticsServer from "@scarn/observability/analytics/server";
import { posthogCaptureCalls } from "./test/posthog-node-mock";
import { initServerAnalytics } from "./analytics";

// Regression coverage for the bug where server-side PostHog events never
// arrived while browser events did: only src/index.ts (the standalone Bun
// server) called init(), but production serves the API through
// apps/next/app/api/[[...slugs]]/route.ts, which imports src/app.ts directly.
// That path left the client null, so every capture was a silent no-op.

const ENV_KEY = "POSTHOG_API_KEY";
const ENV_HOST = "POSTHOG_HOST";

// getOptionalTrimmedEnv() treats blank as unset, so an empty string models
// "not configured" without needing a dynamic delete.
const setEnv = (name: string, value: string | undefined): void => {
  process.env[name] = value ?? "";
};

describe("initServerAnalytics", () => {
  const originalKey = process.env[ENV_KEY];
  const originalHost = process.env[ENV_HOST];

  beforeEach(async () => {
    await analyticsServer.shutdown();
    posthogCaptureCalls.length = 0;
  });

  afterEach(async () => {
    await analyticsServer.shutdown();
    setEnv(ENV_KEY, originalKey);
    setEnv(ENV_HOST, originalHost);
  });

  test("initializes the client when both env vars are set", () => {
    setEnv(ENV_KEY, "phc_test");
    setEnv(ENV_HOST, "https://t.example.test");

    expect(initServerAnalytics()).toBe(true);
    expect(analyticsServer.isInitialized()).toBe(true);
  });

  test("captures actually reach the client after init", () => {
    setEnv(ENV_KEY, "phc_test");
    setEnv(ENV_HOST, "https://t.example.test");
    initServerAnalytics();

    analyticsServer.captureSignup("user-1", {
      provider: "github",
      email_verified: true,
    });

    expect(posthogCaptureCalls).toHaveLength(1);
    expect(posthogCaptureCalls[0]).toMatchObject({
      distinctId: "user-1",
      event: "user_signed_up",
    });
  });

  test("stays disabled when the key is missing", () => {
    setEnv(ENV_KEY, undefined);
    setEnv(ENV_HOST, "https://t.example.test");

    expect(initServerAnalytics()).toBe(false);
    expect(analyticsServer.isInitialized()).toBe(false);
  });

  test("stays disabled when the host is missing", () => {
    setEnv(ENV_KEY, "phc_test");
    setEnv(ENV_HOST, undefined);

    expect(initServerAnalytics()).toBe(false);
    expect(analyticsServer.isInitialized()).toBe(false);
  });

  test("is idempotent and does not re-initialize an existing client", () => {
    setEnv(ENV_KEY, "phc_test");
    setEnv(ENV_HOST, "https://t.example.test");

    expect(initServerAnalytics()).toBe(true);
    // A second call must be a cheap no-op rather than replacing the client and
    // dropping whatever it had queued.
    expect(initServerAnalytics()).toBe(true);
    expect(analyticsServer.isInitialized()).toBe(true);
  });
});

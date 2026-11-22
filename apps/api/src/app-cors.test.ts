import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext } from "@scarn/core/lib/di";
import { noopLogger } from "@scarn/observability/logging";
import { createApp } from "./app";

const APP_ORIGIN = "https://app.example.test";
const TEST_ENV = {
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_TRUSTED_ORIGINS: APP_ORIGIN,
} as const;

describe("CORS on the mounted app", () => {
  const savedEnv = new Map<string, string | undefined>();
  const app = createApp(createAppContext({ logger: noopLogger }));

  beforeEach(() => {
    for (const [key, value] of Object.entries(TEST_ENV)) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    savedEnv.clear();
  });

  test("answers a preflight for a nested route", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/projects", {
        method: "OPTIONS",
        headers: {
          origin: APP_ORIGIN,
          "access-control-request-method": "POST",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      APP_ORIGIN,
    );
  });

  test("adds CORS headers to an error response from a route", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/projects", {
        headers: { origin: APP_ORIGIN },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      APP_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
  });
});

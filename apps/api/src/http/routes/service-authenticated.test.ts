import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiErrorHandler } from "../error-handler";
import { createServiceAuthenticated } from "./service-authenticated";

const SECRET = "test-service-token-0123456789abcdef";
const OTHER_SECRET = "test-github-service-token-abcdef0123456789";

// A minimal app mounting the guard ahead of a trivial protected route, with the
// real API error handler so thrown CoreError/ConfigurationError map to HTTP
// status codes the same way they do in production.
const buildApp = (serviceTokenEnv?: string) =>
  new Elysia()
    .onError((context) => apiErrorHandler(context))
    .use(createServiceAuthenticated(serviceTokenEnv))
    .post("/protected", () => ({ ok: true }));

const post = (app: ReturnType<typeof buildApp>, headers?: HeadersInit) =>
  app.handle(
    new Request("http://localhost/protected", { method: "POST", headers }),
  );

describe("createServiceAuthenticated", () => {
  let original: string | undefined;
  let originalOther: string | undefined;

  beforeEach(() => {
    original = process.env["RECONCILE_CRON_SECRET"];
    process.env["RECONCILE_CRON_SECRET"] = SECRET;
    originalOther = process.env["GITHUB_RECONCILE_CRON_SECRET"];
    process.env["GITHUB_RECONCILE_CRON_SECRET"] = OTHER_SECRET;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["RECONCILE_CRON_SECRET"];
    } else {
      process.env["RECONCILE_CRON_SECRET"] = original;
    }
    if (originalOther === undefined) {
      delete process.env["GITHUB_RECONCILE_CRON_SECRET"];
    } else {
      process.env["GITHUB_RECONCILE_CRON_SECRET"] = originalOther;
    }
  });

  test("allows a request bearing the correct token", async () => {
    const res = await post(buildApp(), { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("rejects a missing Authorization header with 401", async () => {
    const res = await post(buildApp());
    expect(res.status).toBe(401);
  });

  test("rejects a wrong token with 401", async () => {
    const res = await post(buildApp(), { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  test("rejects a non-Bearer scheme with 401", async () => {
    const res = await post(buildApp(), { authorization: SECRET });
    expect(res.status).toBe(401);
  });

  test("fails closed with 500 when the secret is not configured", async () => {
    delete process.env["RECONCILE_CRON_SECRET"];
    const res = await post(buildApp(), { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(500);
  });

  test("a parameterized guard accepts a token matching its own env var", async () => {
    const res = await post(buildApp("GITHUB_RECONCILE_CRON_SECRET"), {
      authorization: `Bearer ${OTHER_SECRET}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("a parameterized guard rejects a token that only matches the default env var (cross-secret isolation)", async () => {
    const res = await post(buildApp("GITHUB_RECONCILE_CRON_SECRET"), {
      authorization: `Bearer ${SECRET}`,
    });
    expect(res.status).toBe(401);
  });

  test("the default (no-arg) guard rejects a token that only matches a different env var", async () => {
    const res = await post(buildApp(), {
      authorization: `Bearer ${OTHER_SECRET}`,
    });
    expect(res.status).toBe(401);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { cors } from "./cors";

const APP_ORIGIN = "https://app.example.test";
const OTHER_ORIGIN = "https://evil.example.test";

const createTestApp = () =>
  new Elysia({ prefix: "/api" })
    .use(cors())
    .get("/things", () => ({ ok: true }))
    .post("/things", () => ({ ok: true }))
    .get(
      "/raw",
      () =>
        new Response("raw", {
          headers: { "set-cookie": "session=abc; Path=/" },
        }),
    )
    .get("/boom", ({ status }) => status(404, { code: "NOT_FOUND" }));

describe("cors", () => {
  const originalTrustedOrigins = process.env["BETTER_AUTH_TRUSTED_ORIGINS"];

  beforeEach(() => {
    process.env["BETTER_AUTH_TRUSTED_ORIGINS"] = APP_ORIGIN;
  });

  afterEach(() => {
    if (originalTrustedOrigins === undefined) {
      delete process.env["BETTER_AUTH_TRUSTED_ORIGINS"];
    } else {
      process.env["BETTER_AUTH_TRUSTED_ORIGINS"] = originalTrustedOrigins;
    }
  });

  test("allows a trusted origin with credentials", async () => {
    const response = await createTestApp().handle(
      new Request("http://localhost/api/things", {
        headers: { origin: APP_ORIGIN },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      APP_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  test("adds headers to handler-built responses and error responses", async () => {
    const app = createTestApp();
    const raw = await app.handle(
      new Request("http://localhost/api/raw", {
        headers: { origin: APP_ORIGIN },
      }),
    );
    const error = await app.handle(
      new Request("http://localhost/api/boom", {
        headers: { origin: APP_ORIGIN },
      }),
    );

    expect(raw.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(raw.headers.get("set-cookie")).toBe("session=abc; Path=/");
    expect(error.status).toBe(404);
    expect(error.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
  });

  test("sends no CORS headers to an untrusted origin", async () => {
    const response = await createTestApp().handle(
      new Request("http://localhost/api/things", {
        headers: { origin: OTHER_ORIGIN },
      }),
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("vary")).toBe("Origin");
  });

  test("answers a preflight from a trusted origin", async () => {
    const response = await createTestApp().handle(
      new Request("http://localhost/api/things", {
        method: "OPTIONS",
        headers: {
          origin: APP_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      APP_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "Content-Type",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "x-scarn-client",
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });

  test("answers a preflight from an untrusted origin without allowing it", async () => {
    const response = await createTestApp().handle(
      new Request("http://localhost/api/things", {
        method: "OPTIONS",
        headers: {
          origin: OTHER_ORIGIN,
          "access-control-request-method": "POST",
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
  });

  test("leaves same-origin requests without an Origin header alone", async () => {
    const response = await createTestApp().handle(
      new Request("http://localhost/api/things"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
  });
});

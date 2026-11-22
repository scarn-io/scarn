import { describe, expect, test } from "bun:test";
import { createIdentityAuth } from "@/lib/auth";

const origin = "http://localhost";

const createAuthRequest = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);

  return new Request(`http://localhost/api/auth${path}`, {
    ...init,
    headers,
  });
};

describe("device auth post", () => {
  test.concurrent("rejects unknown device authorization clients", async () => {
    const auth = createIdentityAuth();

    const response = await auth.handler(
      createAuthRequest("/device/code", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: "unknown-client",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_client",
    });
  });

  test.concurrent("returns null for malformed bearer tokens", async () => {
    const auth = createIdentityAuth();

    const response = await auth.handler(
      createAuthRequest("/get-session", {
        method: "GET",
        headers: {
          authorization: "Bearer definitely-invalid",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });
});

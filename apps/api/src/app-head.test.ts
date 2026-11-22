import { describe, expect, test } from "bun:test";
import { createAppContext } from "@scarn/core/lib/di";
import { noopLogger } from "@scarn/observability/logging";
import { createApp } from "./app";

/**
 * Next's `/api/[[...slugs]]` route serves HEAD through its GET handler, and
 * Elysia 2 no longer answers HEAD for GET routes on its own, so `createApp`
 * installs `elysia/auto-head`.
 */
describe("HEAD requests", () => {
  const app = createApp(createAppContext({ logger: noopLogger }));

  test("a GET route answers HEAD with its status and headers but no body", async () => {
    const get = await app.handle(
      new Request("http://localhost/api/openapi/json"),
    );
    const head = await app.handle(
      new Request("http://localhost/api/openapi/json", { method: "HEAD" }),
    );

    expect(head.status).toBe(get.status);
    expect(head.headers.get("content-type")).toBe(
      get.headers.get("content-type"),
    );
    expect(await head.text()).toBe("");
  });
});

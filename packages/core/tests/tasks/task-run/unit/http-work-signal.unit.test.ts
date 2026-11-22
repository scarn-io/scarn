import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { noopLogger } from "@scarn/observability/logging";
import { HttpWorkSignal } from "@/tasks/task-run/infra/http-work-signal";

type ReceivedRequest = {
  method: string;
  path: string;
  authorization: string | null;
};

describe("HttpWorkSignal", () => {
  const received: ReceivedRequest[] = [];
  let respond: () => Response | Promise<Response> = () =>
    Response.json({ notified: 1 });
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        received.push({
          method: request.method,
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
        });
        return respond();
      },
    });
  });

  afterAll(async () => {
    await server.stop(true);
  });

  const signalFor = (url: string, timeoutMs?: number) =>
    new HttpWorkSignal({
      url,
      notifySecret: "notify-secret",
      logger: noopLogger,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

  test("posts to the project's notify URL with the bearer secret", async () => {
    received.length = 0;
    respond = () => Response.json({ notified: 1 });

    await signalFor(`${server.url.origin}/`).notify("project-1");

    expect(received).toEqual([
      {
        method: "POST",
        path: "/projects/project-1/notify",
        authorization: "Bearer notify-secret",
      },
    ]);
  });

  test("swallows a 5xx response", async () => {
    received.length = 0;
    respond = () => new Response("boom", { status: 503 });

    await signalFor(server.url.origin).notify("project-1");

    expect(received).toHaveLength(1);
  });

  test("swallows a timeout without waiting for the response", async () => {
    respond = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(new Response(null, { status: 200 }));
        }, 2000);
      });

    const startedAt = performance.now();
    await signalFor(server.url.origin, 50).notify("project-1");

    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  test("swallows a refused connection", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const url = closed.url.origin;
    await closed.stop(true);

    const startedAt = performance.now();
    await signalFor(url).notify("project-1");

    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});

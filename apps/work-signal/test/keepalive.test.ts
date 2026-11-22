/**
 * The worker's keepalive must hit the Durable Object's WebSocket
 * auto-response exactly; otherwise every keepalive (about every 30 s per
 * worker) wakes the object. `packages/worker` can't import from `apps/`, so
 * the constants are duplicated there and cross-checked here.
 */
import { describe, expect, it } from "vitest";
import workerClientSource from "../../../packages/worker/src/work/task-run/infra/work-signal-client.ts?raw";
import { KEEPALIVE_PING, KEEPALIVE_PONG } from "../src/keepalive";

const WORKER_CLIENT_PATH =
  "packages/worker/src/work/task-run/infra/work-signal-client.ts";

describe("keepalive constants", () => {
  it.each([
    ["KEEPALIVE_PING", KEEPALIVE_PING],
    ["KEEPALIVE_PONG", KEEPALIVE_PONG],
  ])("%s matches the worker client", (name, value) => {
    expect(
      workerClientSource,
      `${WORKER_CLIENT_PATH} must declare ${name} = "${value}"`,
    ).toContain(`${name} = "${value}"`);
  });
});

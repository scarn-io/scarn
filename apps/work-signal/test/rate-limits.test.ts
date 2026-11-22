/**
 * Edge rate limits (`src/limits.ts`) against the real miniflare limiters that
 * `wrangler.jsonc` configures. Windows are aligned to the wall clock, so each
 * burst asserts that the first `limit` requests pass and that a 429 arrives
 * within two windows' worth.
 */
import { signLogFeedToken } from "@scarn/core/tasks/task-log/domain/log-feed-token";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import deployJson from "../deploy.json";
import {
  connectRequest,
  notifyRequest,
  nowSeconds,
  randomIp,
  signToken,
  statusesUntilLimited,
  validClaims,
} from "./helpers";

const LIMITS = Object.fromEntries(
  deployJson.ratelimits.map((limiter) => [limiter.name, limiter.simple.limit]),
);

function limitOf(name: string): number {
  const limit = LIMITS[name];
  if (limit === undefined) throw new Error(`no rate limiter ${name}`);
  return limit;
}

function expectLimitedAfter(statuses: number[], limit: number, ok: number) {
  expect(statuses.slice(0, limit)).toEqual(Array<number>(limit).fill(ok));
  expect(statuses.at(-1)).toBe(429);
}

function internalRequest(
  taskRunId: string,
  secret: string,
  ip: string,
): Promise<Response> {
  return exports.default.fetch(
    `http://work-signal/internal/task-runs/${taskRunId}/read-all`,
    {
      headers: { Authorization: `Bearer ${secret}`, "cf-connecting-ip": ip },
    },
  );
}

function feedToken(
  taskRunId: string,
  scope: "write" | "read",
  extra: Record<string, unknown> = { oid: "org-1" },
): Promise<string> {
  return signLogFeedToken(
    {
      tid: taskRunId,
      pid: "project-1",
      scope,
      exp: nowSeconds() + 900,
      ...extra,
    } as Parameters<typeof signLogFeedToken>[0],
    env.LOG_FEED_TOKEN_SECRET,
  );
}

function feedRequest(
  taskRunId: string,
  token: string,
  ip: string = randomIp(),
): Promise<Response> {
  return exports.default.fetch(
    `http://work-signal/task-runs/${taskRunId}/ws?token=${encodeURIComponent(token)}`,
    { headers: { Upgrade: "websocket", "cf-connecting-ip": ip } },
  );
}

describe("failed auth limit", () => {
  const limit = limitOf("AUTH_FAIL_LIMITER");

  it("answers failed notifies from one IP with 429 once over the limit", async () => {
    const ip = randomIp();
    const statuses = await statusesUntilLimited(
      () => notifyRequest("project-auth-fail", "wrong", ip),
      2 * limit + 1,
    );
    expectLimitedAfter(statuses, limit, 401);

    const other = await notifyRequest("project-auth-fail", "wrong");
    expect(other.status).toBe(401);
  });

  it("never limits valid notifies or internal calls, even from a limited IP", async () => {
    const ip = randomIp();
    const failed = await statusesUntilLimited(
      () => internalRequest("run-auth-fail", "wrong", ip),
      2 * limit + 1,
    );
    expectLimitedAfter(failed, limit, 401);

    for (let i = 0; i < 2 * limit; i++) {
      expect((await notifyRequest("project-valid", undefined, ip)).status).toBe(
        200,
      );
      expect(
        (await internalRequest("run-valid", env.LOG_FEED_INTERNAL_SECRET, ip))
          .status,
      ).toBe(200);
    }
  });

  it("counts failed work-signal and log-feed tokens", async () => {
    const ip = randomIp();
    let sent = 0;
    const statuses = await statusesUntilLimited(
      () =>
        sent++ % 2 === 0
          ? connectRequest("project-bad-token", "not-a-jwt", ip)
          : feedRequest("run-bad-token", "not-a-jwt", ip),
      2 * limit + 1,
    );
    expectLimitedAfter(statuses, limit, 401);
  });
});

describe("work-signal connect limits", () => {
  it("limits connects per org and worker, before reaching the project", async () => {
    const limit = limitOf("WS_WORKER_LIMITER");
    const projectId = "project-worker-limit";
    const token = await signToken(
      validClaims(projectId, "worker-1", "org-worker-limit"),
    );
    const statuses = await statusesUntilLimited(
      () => connectRequest(projectId, token),
      2 * limit + 1,
    );
    expectLimitedAfter(statuses, limit, 101);

    const limited = await connectRequest(projectId, token);
    expect(limited.status).toBe(429);
    expect(limited.webSocket).toBeNull();

    const otherWorker = await connectRequest(
      projectId,
      await signToken(validClaims(projectId, "worker-2", "org-worker-limit")),
    );
    expect(otherWorker.status).toBe(101);
    otherWorker.webSocket?.accept();
    otherWorker.webSocket?.close();
  });

  it("limits connects per org across workers", async () => {
    const limit = limitOf("WS_ORG_LIMITER");
    const projectId = "project-org-limit";
    let worker = 0;
    const statuses = await statusesUntilLimited(
      async () =>
        connectRequest(
          projectId,
          await signToken(
            validClaims(projectId, `worker-${String(worker++)}`, "org-limit"),
          ),
        ),
      2 * limit + 1,
    );
    expectLimitedAfter(statuses, limit, 101);

    const otherOrg = await connectRequest(
      projectId,
      await signToken(validClaims(projectId, "worker-0", "org-other")),
    );
    expect(otherOrg.status).toBe(101);
    otherOrg.webSocket?.accept();
    otherOrg.webSocket?.close();
  }, 30_000);
});

describe("log-feed connect limits", () => {
  it("limits writer connects per task run", async () => {
    const limit = limitOf("FEED_WRITER_LIMITER");
    const taskRunId = "run-writer-limit";
    const token = await feedToken(taskRunId, "write");
    const statuses = await statusesUntilLimited(
      () => feedRequest(taskRunId, token),
      2 * limit + 1,
    );
    expectLimitedAfter(statuses, limit, 101);

    const limited = await feedRequest(taskRunId, token);
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("Too many requests");

    const reader = await feedRequest(
      taskRunId,
      await feedToken(taskRunId, "read"),
    );
    expect(reader.status).toBe(101);
    reader.webSocket?.accept();
    reader.webSocket?.close();
  });

  it("limits reader connects per IP and task run", async () => {
    const limit = limitOf("FEED_READER_LIMITER");
    const taskRunId = "run-reader-limit";
    const token = await feedToken(taskRunId, "read");
    const ip = randomIp();
    const statuses = await statusesUntilLimited(
      () => feedRequest(taskRunId, token, ip),
      2 * limit + 1,
    );
    expectLimitedAfter(statuses, limit, 101);

    const limited = await feedRequest(taskRunId, token, ip);
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe("Too many requests");

    const otherRun = await feedRequest(
      "run-reader-limit-2",
      await feedToken("run-reader-limit-2", "read"),
      ip,
    );
    expect(otherRun.status).toBe(101);
    otherRun.webSocket?.accept();
    otherRun.webSocket?.close();
  });

  it("accepts a read token without an org id", async () => {
    const taskRunId = "run-read-no-oid";
    const response = await feedRequest(
      taskRunId,
      await feedToken(taskRunId, "read", {}),
    );
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("rejects a write token without an org id with 401", async () => {
    const taskRunId = "run-write-no-oid";
    const response = await feedRequest(
      taskRunId,
      await feedToken(taskRunId, "write", {}),
    );
    expect(response.status).toBe(401);
    expect(response.webSocket).toBeNull();
  });
});

/**
 * Metering (`src/metering.ts`): the edge Worker's handler is called with a
 * recording `EDGE_EVENTS` binding, and with always-failing limiters where a
 * test needs a rate rejection without exhausting a real window.
 */
import { signLogFeedToken } from "@scarn/core/tasks/task-log/domain/log-feed-token";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { record } from "../src/metering";
import {
  connectWorker,
  nowSeconds,
  randomIp,
  signToken,
  validClaims,
} from "./helpers";

const exhausted: RateLimit = {
  limit: () => Promise.resolve({ success: false }),
};

function recordingEnv(overrides: Partial<Cloudflare.Env> = {}) {
  const points: AnalyticsEngineDataPoint[] = [];
  const testEnv: Cloudflare.Env = {
    ...env,
    EDGE_EVENTS: {
      writeDataPoint: (point) => {
        if (point) points.push(point);
      },
    },
    ...overrides,
  };
  return { points, testEnv };
}

async function send(
  testEnv: Cloudflare.Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", randomIp());
  const request = new Request(`http://work-signal${path}`, {
    ...init,
    headers,
  }) as Request<unknown, IncomingRequestCfProperties>;
  const response = await worker.fetch(request, testEnv);
  response.webSocket?.accept();
  response.webSocket?.close();
  return response;
}

const upgrade = { headers: { Upgrade: "websocket" } };

function feedToken(
  taskRunId: string,
  scope: "write" | "read",
): Promise<string> {
  return signLogFeedToken(
    {
      tid: taskRunId,
      pid: "project-meter",
      oid: "org-meter",
      scope,
      exp: nowSeconds() + 900,
    },
    env.LOG_FEED_TOKEN_SECRET,
  );
}

function point(
  event: string,
  ids: { pid?: string; oid?: string; tid?: string; sub?: string },
  reason = "",
  notified = 0,
): AnalyticsEngineDataPoint {
  return {
    indexes: [ids.oid ?? ids.pid ?? ""],
    blobs: [
      event,
      ids.pid ?? "",
      ids.oid ?? "",
      ids.tid ?? "",
      ids.sub ?? "",
      reason,
    ],
    doubles: [1, notified],
  };
}

describe("metering connects", () => {
  it("records one signal_connect per work-signal connect", async () => {
    const { points, testEnv } = recordingEnv();
    const token = await signToken(
      validClaims("project-meter", "worker-1", "org-meter"),
    );
    const response = await send(
      testEnv,
      `/projects/project-meter/connect?token=${token}`,
      upgrade,
    );
    expect(response.status).toBe(101);
    expect(points).toEqual([
      point("signal_connect", {
        pid: "project-meter",
        oid: "org-meter",
        sub: "worker-1",
      }),
    ]);
  });

  it.each([
    ["write", "feed_writer_connect"],
    ["read", "feed_reader_connect"],
  ] as const)("records %s log-feed connects as %s", async (scope, event) => {
    const { points, testEnv } = recordingEnv();
    const tid = `run-meter-${scope}`;
    const response = await send(
      testEnv,
      `/task-runs/${tid}/ws?token=${await feedToken(tid, scope)}`,
      upgrade,
    );
    expect(response.status).toBe(101);
    expect(points).toEqual([
      point(event, { pid: "project-meter", oid: "org-meter", tid }),
    ]);
  });
});

describe("metering notify", () => {
  it("records the number of workers woken", async () => {
    const projectId = "project-meter-notify";
    const sockets = [
      await connectWorker(projectId, "worker-1"),
      await connectWorker(projectId, "worker-2"),
    ];
    const { points, testEnv } = recordingEnv();
    const response = await send(testEnv, `/projects/${projectId}/notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WORK_SIGNAL_NOTIFY_SECRET}` },
    });
    expect(await response.json()).toEqual({ notified: 2 });
    expect(points).toEqual([point("notify", { pid: projectId }, "", 2)]);
    for (const { socket } of sockets) socket.close();
  });
});

describe("metering rejections", () => {
  it("records failed auth on each route with the ids its path carries", async () => {
    const { points, testEnv } = recordingEnv();
    await send(testEnv, "/projects/p-auth/notify", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    await send(testEnv, "/projects/p-auth/connect?token=bad", upgrade);
    await send(testEnv, "/task-runs/t-auth/ws?token=bad", upgrade);
    await send(testEnv, "/internal/task-runs/t-internal/read-all", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(points).toEqual([
      point("rejected", { pid: "p-auth" }, "auth"),
      point("rejected", { pid: "p-auth" }, "auth"),
      point("rejected", { tid: "t-auth" }, "auth"),
      point("rejected", { tid: "t-internal" }, "auth"),
    ]);
  });

  it("records rate_ip once failed auth is over the limit", async () => {
    const { points, testEnv } = recordingEnv({ AUTH_FAIL_LIMITER: exhausted });
    const response = await send(testEnv, "/projects/p-ip/notify", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    expect(response.status).toBe(429);
    expect(points).toEqual([point("rejected", { pid: "p-ip" }, "rate_ip")]);
  });

  it.each([
    ["WS_WORKER_LIMITER", "rate_worker"],
    ["WS_ORG_LIMITER", "rate_org"],
  ] as const)("records %s rejections as %s", async (limiter, reason) => {
    const { points, testEnv } = recordingEnv({ [limiter]: exhausted });
    const token = await signToken(
      validClaims("project-meter", "worker-1", "org-meter"),
    );
    const response = await send(
      testEnv,
      `/projects/project-meter/connect?token=${token}`,
      upgrade,
    );
    expect(response.status).toBe(429);
    expect(points).toEqual([
      point(
        "rejected",
        { pid: "project-meter", oid: "org-meter", sub: "worker-1" },
        reason,
      ),
    ]);
  });

  it.each([
    ["write", "FEED_WRITER_LIMITER", "rate_writer"],
    ["read", "FEED_READER_LIMITER", "rate_reader"],
  ] as const)(
    "records %s log-feed limits as %s",
    async (scope, limiter, reason) => {
      const { points, testEnv } = recordingEnv({ [limiter]: exhausted });
      const tid = `run-meter-limited-${scope}`;
      const response = await send(
        testEnv,
        `/task-runs/${tid}/ws?token=${await feedToken(tid, scope)}`,
        upgrade,
      );
      expect(response.status).toBe(429);
      expect(points).toEqual([
        point(
          "rejected",
          { pid: "project-meter", oid: "org-meter", tid },
          reason,
        ),
      ]);
    },
  );
});

describe("metering exclusions", () => {
  it("records nothing for successful internal calls or appends", async () => {
    const { points, testEnv } = recordingEnv();
    const auth = { Authorization: `Bearer ${env.LOG_FEED_INTERNAL_SECRET}` };
    const append = await send(testEnv, "/internal/task-runs/t-ok/append", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        lines: [
          {
            seq: 0,
            stream: "worker",
            ts: new Date().toISOString(),
            content: "hello",
            level: "info",
          },
        ],
      }),
    });
    expect(append.status).toBe(200);
    await send(testEnv, "/internal/task-runs/t-ok/read-all", { headers: auth });
    await send(testEnv, "/health");
    expect(points).toEqual([]);
  });

  it("swallows a failing dataset write", () => {
    const failing: Cloudflare.Env = {
      ...env,
      EDGE_EVENTS: {
        writeDataPoint: () => {
          throw new Error("dataset down");
        },
      },
    };
    expect(() => {
      record(failing, { event: "notify", pid: "p", notified: 0 });
    }).not.toThrow();
  });
});

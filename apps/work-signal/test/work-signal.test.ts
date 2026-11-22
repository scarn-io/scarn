import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CLOSE_POLICY_VIOLATION,
  MAX_SOCKETS_PER_PROJECT,
  MAX_SOCKETS_PER_WORKER,
  type ProjectWorkSignal,
  TOKEN_EXP_HEADER,
  WORK_MESSAGE,
  WORKER_ID_HEADER,
} from "../src/project-work-signal";
import {
  connectRequest,
  connectWorker,
  notifyRequest,
  nowSeconds,
  projectStub,
  signToken,
  validClaims,
} from "./helpers";

function socketCount(projectId: string): Promise<number> {
  return runInDurableObject(
    projectStub(projectId),
    (_instance: ProjectWorkSignal, state) => state.getWebSockets().length,
  );
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.addEventListener("close", (event) => {
      resolve(event.code);
    });
  });
}

/**
 * Connects straight to the Durable Object, past the edge rate limiters, as
 * the Worker does after verifying a token.
 */
async function doConnect(
  projectId: string,
  workerId: string,
  exp = nowSeconds() + 3600,
): Promise<Response> {
  const response = await projectStub(projectId).fetch(
    `http://work-signal/projects/${projectId}/connect`,
    {
      headers: {
        Upgrade: "websocket",
        [WORKER_ID_HEADER]: workerId,
        [TOKEN_EXP_HEADER]: String(exp),
      },
    },
  );
  response.webSocket?.accept();
  return response;
}

describe("GET /health", () => {
  it("returns 200 without auth", async () => {
    const response = await exports.default.fetch("http://work-signal/health");
    expect(response.status).toBe(200);
  });
});

describe("notify", () => {
  it("reaches every connected socket of that project only", async () => {
    const a1 = await connectWorker("project-a", "worker-a1");
    const a2 = await connectWorker("project-a", "worker-a2");
    const b1 = await connectWorker("project-b", "worker-b1");

    const response = await notifyRequest("project-a");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notified: 2 });

    expect(await a1.nextMessage()).toBe(WORK_MESSAGE);
    expect(await a2.nextMessage()).toBe(WORK_MESSAGE);
    expect(JSON.parse(WORK_MESSAGE)).toEqual({ t: "work" });

    b1.socket.send("ping");
    expect(await b1.nextMessage()).toBe("pong");
    expect(b1.messages).toEqual(["pong"]);
  });

  it("returns 401 for a wrong secret without reaching the project", async () => {
    const worker = await connectWorker("project-wrong-secret");
    const response = await notifyRequest(
      "project-wrong-secret",
      "not-the-secret",
    );
    expect(response.status).toBe(401);

    worker.socket.send("ping");
    expect(await worker.nextMessage()).toBe("pong");
    expect(worker.messages).toEqual(["pong"]);
  });

  it("returns 401 without an Authorization header", async () => {
    const response = await exports.default.fetch(
      "http://work-signal/projects/project-x/notify",
      { method: "POST" },
    );
    expect(response.status).toBe(401);
  });

  it("closes sockets whose token has expired instead of notifying them", async () => {
    const projectId = "project-expiring";
    const worker = await connectWorker(projectId);
    const closed = new Promise<number>((resolve) => {
      worker.socket.addEventListener("close", (event) => {
        resolve(event.code);
      });
    });
    await runInDurableObject(
      projectStub(projectId),
      (_instance: ProjectWorkSignal, state) => {
        for (const socket of state.getWebSockets()) {
          socket.serializeAttachment({
            workerId: "worker-1",
            exp: nowSeconds() - 1,
          });
        }
      },
    );

    const response = await notifyRequest(projectId);
    expect(await response.json()).toEqual({ notified: 0 });
    expect(await closed).toBe(4001);
  });

  it("still reaches the socket after the Durable Object is evicted", async () => {
    const projectId = "project-hibernating";
    const worker = await connectWorker(projectId);
    const stub = projectStub(projectId);

    await evictDurableObject(stub);

    const response = await notifyRequest(projectId);
    expect(await response.json()).toEqual({ notified: 1 });
    expect(await worker.nextMessage()).toBe(WORK_MESSAGE);
  });
});

describe("connect", () => {
  it("stores the worker id and token expiry on the socket", async () => {
    const projectId = "project-attachment";
    await connectWorker(projectId, "worker-42");
    const attachments = await runInDurableObject(
      projectStub(projectId),
      (_instance: ProjectWorkSignal, state) =>
        state
          .getWebSockets()
          .map((socket) => socket.deserializeAttachment() as unknown),
    );
    expect(attachments).toEqual([
      { workerId: "worker-42", exp: expect.any(Number) as number },
    ]);
  });

  it("answers ping with pong", async () => {
    const worker = await connectWorker("project-ping");
    worker.socket.send("ping");
    expect(await worker.nextMessage()).toBe("pong");
  });

  it.each([
    ["a malformed token", () => Promise.resolve("not-a-jwt")],
    [
      "a token signed with another secret",
      () => signToken(validClaims("project-c"), "wrong"),
    ],
    [
      "an expired token",
      () =>
        signToken({
          ...validClaims("project-c"),
          exp: nowSeconds() - 10,
        }),
    ],
    ["another project's token", () => signToken(validClaims("project-other"))],
    [
      "a token without an org id",
      () =>
        signToken({
          pid: "project-c",
          sub: "worker-1",
          exp: nowSeconds() + 60,
        }),
    ],
    [
      "a token with a non-HS256 header",
      () => signToken(validClaims("project-c"), undefined, { alg: "none" }),
    ],
    [
      "a token missing sub",
      () =>
        signToken({ pid: "project-c", oid: "org-1", exp: nowSeconds() + 60 }),
    ],
    [
      "a token with a non-string oid",
      () => signToken({ ...validClaims("project-c"), oid: 42 }),
    ],
    [
      "a token with an empty oid",
      () => signToken({ ...validClaims("project-c"), oid: "" }),
    ],
  ])(
    "rejects %s before reaching the Durable Object",
    async (_label, makeToken) => {
      const response = await connectRequest("project-c", await makeToken());
      expect(response.status).toBe(401);
      expect(response.webSocket).toBeNull();
      expect(await socketCount("project-c")).toBe(0);
    },
  );

  it("closes a client that sends anything but ping with 1008 and no reply", async () => {
    const worker = await connectWorker("project-client-message");
    const closed = closeCode(worker.socket);
    worker.socket.send("x");
    expect(await closed).toBe(CLOSE_POLICY_VIOLATION);
    expect(worker.messages).toEqual([]);
  });

  it("refuses a worker id's fourth socket with 429 and admits it again once one closes", async () => {
    const projectId = "project-worker-cap";
    const sockets = [];
    for (let i = 0; i < MAX_SOCKETS_PER_WORKER; i++) {
      sockets.push(await doConnect(projectId, "worker-capped"));
    }
    const refused = await connectRequest(
      projectId,
      await signToken(validClaims(projectId, "worker-capped")),
    );
    expect(refused.status).toBe(429);
    expect(refused.webSocket).toBeNull();

    const other = await connectWorker(projectId, "worker-other");
    other.socket.send("ping");
    expect(await other.nextMessage()).toBe("pong");

    sockets[0]?.webSocket?.close(1000, "refresh");
    await expect
      .poll(async () => (await doConnect(projectId, "worker-capped")).status)
      .toBe(101);
  });

  it("ends 20 sockets on one worker id with 3", async () => {
    const projectId = "project-twenty";
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      statuses.push((await doConnect(projectId, "worker-greedy")).status);
    }
    expect(statuses.filter((status) => status === 101)).toHaveLength(3);
    expect(statuses.slice(3).every((status) => status === 429)).toBe(true);
    expect(await socketCount(projectId)).toBe(3);
  });

  it("closes a worker id's expired sockets instead of counting them", async () => {
    const projectId = "project-worker-cap-expired";
    for (let i = 0; i < MAX_SOCKETS_PER_WORKER; i++) {
      await doConnect(projectId, "worker-stale", nowSeconds() - 1);
    }
    const response = await doConnect(projectId, "worker-stale");
    expect(response.status).toBe(101);
  });

  it("refuses a connect with 429 once the project holds its socket cap", async () => {
    const projectId = "project-socket-cap";
    for (let i = 0; i < MAX_SOCKETS_PER_PROJECT; i++) {
      const response = await doConnect(projectId, `worker-${String(i)}`);
      expect(response.status).toBe(101);
    }
    const refused = await doConnect(projectId, "worker-late");
    expect(refused.status).toBe(429);
    expect(await socketCount(projectId)).toBe(MAX_SOCKETS_PER_PROJECT);
  });

  it("requires a WebSocket upgrade", async () => {
    const token = await signToken(validClaims("project-c"));
    const response = await exports.default.fetch(
      `http://work-signal/projects/project-c/connect?token=${token}`,
    );
    expect(response.status).toBe(426);
  });
});

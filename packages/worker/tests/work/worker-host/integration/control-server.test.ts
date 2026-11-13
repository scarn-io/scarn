import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SlotAllocator } from "../../../../src/work/worker-host/domain/slot-allocator";
import { CONTROL_API_PROTOCOL } from "../../../../src/work/worker-host/contracts/control-api";
import {
  WorkerBaseUrlMismatchError,
  WorkerNotRunningError,
} from "../../../../src/work/worker-host/domain/worker-supervisor-errors";
import { createControlClient } from "../../../../src/work/worker-host/infra/control-client";
import {
  startControlServer,
  type ControlServer,
} from "../../../../src/work/worker-host/infra/control-server";
import type { StopRequest } from "../../../../src/work/worker-host/infra/control-app";
import { FakeControlSupervisor } from "./helpers/fake-control-supervisor";

const projectBody = {
  projectRef: "acme/app",
  repoDir: "/repos/app",
  sourceBranch: "main",
  baseUrl: "https://scarn.test",
  addedByUserId: "user-1",
  concurrency: 2,
  workItemId: null,
  preserveRuntime: false,
};

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error("response has no body");
  return response.body;
}

describe("control server", () => {
  let dir: string;
  let logFile: string;
  let supervisor: FakeControlSupervisor;
  let slots: SlotAllocator;
  let stopRequests: StopRequest[];
  let server: ControlServer;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "control-server-"));
    logFile = path.join(dir, "worker.log");
    supervisor = new FakeControlSupervisor();
    slots = new SlotAllocator({ machineLimit: 2 });
    stopRequests = [];
    server = startControlServer({
      supervisor,
      slots,
      version: "1.2.3+dev.abc",
      pid: 4242,
      startedAt: "2026-11-12T00:00:00.000Z",
      logFilePath: logFile,
      logPollMs: 10,
      onStopRequested: (request) => stopRequests.push(request),
    });
  });

  afterEach(async () => {
    supervisor.stopped.resolve(undefined);
    await server.close({ force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  const url = (route: string) =>
    `http://127.0.0.1:${String(server.port)}${route}`;
  const client = () => createControlClient(server);
  const auth = () => ({ authorization: `Bearer ${server.token}` });

  describe("guard", () => {
    test("refuses a request without a token with 401", async () => {
      const response = await fetch(url("/health"));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "unauthorized" });
    });

    test("refuses a wrong token with 401", async () => {
      const wrong = await fetch(url("/health"), {
        headers: { authorization: `Bearer ${server.token.slice(1)}x` },
      });
      const shorter = await fetch(url("/health"), {
        headers: { authorization: "Bearer x" },
      });
      expect(wrong.status).toBe(401);
      expect(shorter.status).toBe(401);
    });

    test("refuses a request with an Origin header with 403", async () => {
      const response = await fetch(url("/health"), {
        headers: { ...auth(), origin: "https://evil.test" },
      });
      expect(response.status).toBe(403);
    });

    test("refuses a request for another Host with 403", async () => {
      const localhost = await fetch(
        `http://localhost:${String(server.port)}/health`,
        { headers: auth() },
      );
      const spoofed = await fetch(url("/health"), {
        headers: { ...auth(), host: "evil.test" },
      });
      expect(localhost.status).toBe(403);
      expect(spoofed.status).toBe(403);
    });

    test("never includes the token in a response", async () => {
      const responses = await Promise.all(
        ["/health", "/status"].map((route) =>
          fetch(url(route), { headers: auth() }).then((r) => r.text()),
        ),
      );
      for (const body of responses) expect(body).not.toContain(server.token);
    });
  });

  test("GET /health reports the worker", async () => {
    const { data } = await client().health.get();
    expect(data).toEqual({
      instance: "scarn-test",
      version: "1.2.3+dev.abc",
      protocol: CONTROL_API_PROTOCOL,
      pid: 4242,
      startedAt: "2026-11-12T00:00:00.000Z",
      state: "running",
    });
  });

  test("GET /status asks for recent runs", async () => {
    const { data } = await client().status.get({ query: { recentRuns: 5 } });
    expect(data?.maxConcurrency).toBe(4);
    expect(supervisor.calls).toEqual([
      { method: "status", args: [{ recentRuns: 5 }] },
    ]);
  });

  test("PUT /projects/:projectId adds or updates the project", async () => {
    const { data } = await client()
      .projects({ projectId: "p1" })
      .put(projectBody);
    expect(data).toEqual({ outcome: "added", project: null });
    expect(supervisor.calls).toEqual([
      {
        method: "addOrUpdateProject",
        args: [{ ...projectBody, projectId: "p1" }],
      },
    ]);
  });

  test("PUT /projects maps supervisor errors to 409 with distinct codes", async () => {
    supervisor.addOrUpdateError = new WorkerNotRunningError("scarn-test");
    const notRunning = await client()
      .projects({ projectId: "p1" })
      .put(projectBody);
    supervisor.addOrUpdateError = new WorkerBaseUrlMismatchError(
      "scarn-test",
      "https://a.test",
      "https://b.test",
    );
    const mismatch = await client()
      .projects({ projectId: "p1" })
      .put(projectBody);
    supervisor.addOrUpdateError = new RangeError(
      "concurrency must be a non-negative integer.",
    );
    const range = await client().projects({ projectId: "p1" }).put(projectBody);

    expect(notRunning.status).toBe(409);
    expect(notRunning.error?.value).toMatchObject({
      code: "worker_not_running",
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.error?.value).toMatchObject({ code: "base_url_mismatch" });
    expect(range.status).toBe(400);
    expect(range.error?.value).toMatchObject({ code: "bad_request" });
  });

  test("a body that fails validation gets 400", async () => {
    const response = await fetch(url("/config"), {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrency: -1 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "bad_request" });
    expect(supervisor.calls).toEqual([]);
  });

  test("DELETE /projects/:projectId removes the project", async () => {
    const { data } = await client().projects({ projectId: "p1" }).delete();
    expect(data).toEqual({ removed: true, drainingRuns: [] });
    expect(supervisor.calls).toEqual([
      { method: "removeProject", args: ["p1"] },
    ]);
  });

  test("PATCH /config sets the machine limit", async () => {
    const { data } = await client().config.patch({ maxConcurrency: 6 });
    expect(data).toEqual({ maxConcurrency: 6 });
    expect(supervisor.calls).toEqual([
      { method: "setMachineLimit", args: [6] },
    ]);
  });

  test("POST /runs/:taskRunId/abort cancels the run locally", async () => {
    const found = await client().runs({ taskRunId: "run-1" }).abort.post();
    const missing = await client().runs({ taskRunId: "run-2" }).abort.post();
    expect(found.data).toEqual({ found: true });
    expect(missing.data).toEqual({ found: false });
    expect(supervisor.calls.map((call) => call.args[0])).toEqual([
      "run-1",
      "run-2",
    ]);
  });

  test("POST /stop answers once the stop has started and hands it to the host", async () => {
    const { data } = await client().stop.post({ force: true });
    expect(data).toEqual({ state: "stopping" });
    expect(supervisor.calls).toEqual([
      { method: "stop", args: [{ force: true }] },
    ]);
    expect(stopRequests).toHaveLength(1);
    expect(stopRequests[0]?.force).toBe(true);
    supervisor.stopped.resolve(undefined);
    await stopRequests[0]?.done;
  });

  describe("slots", () => {
    test("acquire, release and heartbeat go through a lease", async () => {
      const first = await client().slots.acquire.post({
        projectId: "p1",
        wanted: 3,
      });
      expect(first.data?.granted).toBe(2);
      const leaseId = first.data?.leaseId ?? "";
      expect(slots.snapshot().machineInUse).toBe(2);

      const beat = await client().slots({ leaseId }).heartbeat.post();
      expect(beat.status).toBe(200);

      await client().slots.release.post({ leaseId, projectId: "p1", count: 1 });
      expect(slots.snapshot().machineInUse).toBe(1);
    });

    test("an unknown lease gets 404", async () => {
      const { status, error } = await client()
        .slots({ leaseId: "nope" })
        .heartbeat.post();
      expect(status).toBe(404);
      expect(error?.value).toMatchObject({ code: "lease_not_found" });
    });

    test("POST /slots/changed wakes when slots are released", async () => {
      const held = await client().slots.acquire.post({
        projectId: "p1",
        wanted: 2,
      });
      const leaseId = held.data?.leaseId ?? "";
      const generation = held.data?.generation ?? 0;
      const waiting = client().slots.changed.post({
        since: generation,
        waitMs: 5_000,
      });
      await Bun.sleep(20);
      await client().slots.release.post({ leaseId, projectId: "p1", count: 1 });
      const { data } = await waiting;
      expect(data?.changed).toBe(true);
      expect(data?.generation).toBeGreaterThan(generation);
    });
  });

  describe("logs", () => {
    const line = (fields: Record<string, string>) =>
      `${JSON.stringify(fields)}\n`;

    test("returns the matching tail", async () => {
      writeFileSync(
        logFile,
        line({ msg: "a", projectId: "p1" }) +
          line({ msg: "b", projectId: "p2" }) +
          line({ msg: "c", projectId: "p1", taskRunId: "r1" }),
      );
      const { data } = await client().logs.get({
        query: { project: "p1", tail: 1 },
      });
      expect(data).toEqual({
        lines: [line({ msg: "c", projectId: "p1", taskRunId: "r1" }).trim()],
      });
    });

    test("follow streams new lines as they are written", async () => {
      writeFileSync(logFile, line({ msg: "old", taskRunId: "r1" }));
      const abort = new AbortController();
      const response = await fetch(url("/logs?run=r1&follow=true"), {
        headers: auth(),
        signal: abort.signal,
      });
      expect(response.headers.get("content-type")).toStartWith(
        "text/event-stream",
      );
      const reader = requireBody(response).getReader();
      const decoder = new TextDecoder();
      let received = "";
      const readUntil = async (text: string) => {
        while (!received.includes(text)) {
          const { value, done } = await reader.read();
          if (done) throw new Error("stream ended");
          received += decoder.decode(value);
        }
      };

      await readUntil('"old"');
      appendFileSync(logFile, line({ msg: "other", taskRunId: "r2" }));
      appendFileSync(logFile, line({ msg: "new", taskRunId: "r1" }));
      await readUntil('"new"');
      abort.abort();

      expect(received).toContain("event: line");
      expect(received).not.toContain('"other"');
    });
  });
});

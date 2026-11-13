import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHomeDirForTests } from "@scarn/sdk/defaults";
import { SlotAllocator } from "../../../../src/work/worker-host/domain/slot-allocator";
import { CONTROL_API_PROTOCOL } from "../../../../src/work/worker-host/contracts/control-api";
import {
  startControlServer,
  type ControlServer,
} from "../../../../src/work/worker-host/infra/control-server";
import {
  findRunningWorker,
  readWorkerDiscovery,
  removeWorkerDiscovery,
  writeWorkerDiscovery,
} from "../../../../src/work/worker-host/infra/worker-discovery";
import {
  ensureWorkerInstanceDir,
  workerDiscoveryFilePath,
} from "../../../../src/work/worker-host/infra/worker-instance-paths";
import { FakeControlSupervisor } from "./helpers/fake-control-supervisor";

const instance = "scarn-test";

describe("worker discovery", () => {
  let home: string;
  let server: ControlServer | null;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "worker-discovery-"));
    setHomeDirForTests(home);
    server = null;
  });

  afterEach(async () => {
    await server?.close({ force: true });
    setHomeDirForTests(undefined);
    rmSync(home, { recursive: true, force: true });
  });

  function startServer(): ControlServer {
    server = startControlServer({
      supervisor: new FakeControlSupervisor(),
      slots: new SlotAllocator({ machineLimit: 1 }),
      version: "1.0.0",
      pid: process.pid,
      startedAt: "2026-11-12T00:00:00.000Z",
      logFilePath: path.join(home, "worker.log"),
    });
    return server;
  }

  function discoveryFor(port: number, token: string, pid = process.pid) {
    return {
      pid,
      port,
      token,
      version: "1.0.0",
      protocol: CONTROL_API_PROTOCOL,
      instance,
      baseUrl: null,
      startedAt: "2026-11-12T00:00:00.000Z",
    };
  }

  test("writes a private file that reads back", () => {
    writeWorkerDiscovery(discoveryFor(1234, "t"));
    expect(readWorkerDiscovery(instance)).toEqual(discoveryFor(1234, "t"));
    if (process.platform !== "win32") {
      expect(statSync(workerDiscoveryFilePath(instance)).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  test("finds a running worker through its health check", async () => {
    const running = startServer();
    writeWorkerDiscovery(discoveryFor(running.port, running.token));

    const found = await findRunningWorker(instance);

    expect(found?.health.instance).toBe(instance);
    expect(found?.discovery.port).toBe(running.port);
    const status = await found?.client.status.get();
    expect(status?.data?.instance).toBe(instance);
  });

  test("deletes a file whose worker does not answer", async () => {
    const stopped = startServer();
    const port = stopped.port;
    await stopped.close({ force: true });
    server = null;
    writeWorkerDiscovery(discoveryFor(port, "token"));

    expect(await findRunningWorker(instance)).toBeNull();
    expect(existsSync(workerDiscoveryFilePath(instance))).toBe(false);
  });

  test("deletes a file whose token is refused", async () => {
    const running = startServer();
    writeWorkerDiscovery(discoveryFor(running.port, "stale-token"));

    expect(await findRunningWorker(instance)).toBeNull();
    expect(existsSync(workerDiscoveryFilePath(instance))).toBe(false);
  });

  test("deletes an unreadable file", async () => {
    ensureWorkerInstanceDir(instance);
    writeFileSync(workerDiscoveryFilePath(instance), "{not json");

    expect(await findRunningWorker(instance)).toBeNull();
    expect(existsSync(workerDiscoveryFilePath(instance))).toBe(false);
  });

  test("removal with onlyIfPid keeps another worker's file", () => {
    writeWorkerDiscovery(discoveryFor(1234, "t", 111));

    expect(removeWorkerDiscovery(instance, { onlyIfPid: 222 })).toBe(false);
    expect(existsSync(workerDiscoveryFilePath(instance))).toBe(true);
    expect(removeWorkerDiscovery(instance, { onlyIfPid: 111 })).toBe(true);
    expect(existsSync(workerDiscoveryFilePath(instance))).toBe(false);
  });
});

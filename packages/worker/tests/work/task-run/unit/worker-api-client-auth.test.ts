/**
 * The worker client reads its bearer token from `auth.jsonc` per request, so a
 * long-running worker follows a re-login, and fails with a typed
 * `WorkerAuthError` when it can no longer act for its user.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  deleteAuthProfile,
  saveAuthProfile,
  setHomeDirForTests,
} from "@scarn/sdk/defaults";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { WorkerAuthError } from "../../../../src/auth/session/domain/worker-auth-error";
import { ProjectUnavailableError } from "../../../../src/work/task-run/contracts/project-unavailable-error";
import { createTaskPlaneWorkerClient } from "../../../../src/work/task-run/infra/worker-api-client";

const USER_A = "01966a2c-9494-7db5-aa46-0f8f5cbbe0a1";
const USER_B = "01966a2c-9494-7db5-aa46-0f8f5cbbe0b2";
const TASK_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let seenAuthorization: (string | null)[];
let responseStatus: number;
let responseBody: Record<string, unknown>;
let fakeHome: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      seenAuthorization.push(request.headers.get("authorization"));
      return Response.json(responseBody, { status: responseStatus });
    },
  });
  baseUrl = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server.stop(true);
});

beforeEach(() => {
  seenAuthorization = [];
  responseStatus = 200;
  responseBody = { id: TASK_ID, status: "running" };
  fakeHome = mkdtempSync(join(tmpdir(), "scarn-worker-auth-"));
  setHomeDirForTests(fakeHome);
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

async function createClient(expectedUserId?: string) {
  return await createTaskPlaneWorkerClient(baseUrl, {
    expectedUserId,
    resolveUserId: () => Promise.resolve(USER_A),
  });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to fail");
}

describe("createTaskPlaneWorkerClient auth", () => {
  test("uses a rotated token on the next call", async () => {
    saveAuthProfile(baseUrl, { accessToken: "token-1", userId: USER_A });
    const client = await createClient();

    await client.getTaskRun({ taskRunId: TASK_ID });
    saveAuthProfile(baseUrl, { accessToken: "token-rotated", userId: USER_A });
    await client.getTaskRun({ taskRunId: TASK_ID });

    expect(seenAuthorization).toEqual([
      "Bearer token-1",
      "Bearer token-rotated",
    ]);
  });

  test("raises user_changed when another user signs in", async () => {
    saveAuthProfile(baseUrl, { accessToken: "token-a", userId: USER_A });
    const client = await createClient();
    saveAuthProfile(baseUrl, { accessToken: "token-b", userId: USER_B });

    const error = await captureError(client.getTaskRun({ taskRunId: TASK_ID }));

    expect(error).toBeInstanceOf(WorkerAuthError);
    expect((error as WorkerAuthError).reason).toBe("user_changed");
    expect(seenAuthorization).toEqual([]);
  });

  test("raises user_changed at creation when the signed-in user is not the expected one", async () => {
    saveAuthProfile(baseUrl, { accessToken: "token-a", userId: USER_A });

    const error = await captureError(createClient(USER_B));

    expect(error).toBeInstanceOf(WorkerAuthError);
    expect((error as WorkerAuthError).reason).toBe("user_changed");
  });

  test("raises auth_missing when the profile is removed", async () => {
    saveAuthProfile(baseUrl, { accessToken: "token-a", userId: USER_A });
    const client = await createClient();
    deleteAuthProfile(baseUrl);

    const error = await captureError(client.getTaskRun({ taskRunId: TASK_ID }));

    expect(error).toBeInstanceOf(WorkerAuthError);
    expect((error as WorkerAuthError).reason).toBe("auth_missing");
  });

  test("raises auth_missing at creation when not signed in", async () => {
    const error = await captureError(createClient());

    expect(error).toBeInstanceOf(WorkerAuthError);
    expect((error as WorkerAuthError).reason).toBe("auth_missing");
  });

  test.each([401, 403])(
    "raises auth_rejected when the server answers %d",
    async (status) => {
      saveAuthProfile(baseUrl, { accessToken: "token-a", userId: USER_A });
      const client = await createClient();
      responseStatus = status;

      const error = await captureError(
        client.getTaskRun({ taskRunId: TASK_ID }),
      );

      expect(error).toBeInstanceOf(WorkerAuthError);
      expect((error as WorkerAuthError).reason).toBe("auth_rejected");
    },
  );

  test.each([
    [404, "PROJECT_NOT_FOUND"],
    [403, "PROJECT_FORBIDDEN"],
  ])(
    "raises ProjectUnavailableError when the server answers %d %s",
    async (status, code) => {
      saveAuthProfile(baseUrl, { accessToken: "token-a", userId: USER_A });
      const client = await createClient();
      responseStatus = status;
      responseBody = { type: "about:blank", title: "x", status, code };

      const error = await captureError(
        client.getTaskRun({ taskRunId: TASK_ID }),
      );

      expect(error).toBeInstanceOf(ProjectUnavailableError);
      expect((error as ProjectUnavailableError).status as number).toBe(status);
    },
  );
});

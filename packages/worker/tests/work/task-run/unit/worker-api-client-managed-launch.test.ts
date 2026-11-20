/**
 * The worker client registers a claimed run's managed launch with the MCP
 * server URLs it resolved, and turns the server's refusals into the typed
 * errors a launch fails with.
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
import { saveAuthProfile, setHomeDirForTests } from "@scarn/sdk/defaults";
import { parseUuidV7 } from "../../../../src/common/contracts/uuid-v7";
import { ManagedConnectionNotReadyError } from "../../../../src/work/task-run/application/managed-connection-not-ready-error";
import { McpConnectionAuthRejectedError } from "../../../../src/work/task-run/application/mcp-connection-auth-rejected-error";
import { isTaskRunCancelledResponse } from "../../../../src/work/task-run/application/task-run-cancelled-error";
import { createTaskPlaneWorkerClient } from "../../../../src/work/task-run/infra/worker-api-client";

const USER_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe0a1";
const TASK_ID = parseUuidV7("01966a2c-9494-7db5-aa46-0f8f5cbbe003");

const urls = {
  entries: { notion: { url: "https://mcp.notion.com/mcp" } },
  remotesWithoutAuth: { plain: { url: "https://example.test/mcp" } },
};

function apiToken(): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 900;
  return `${encode({ alg: "EdDSA" })}.${encode({ exp, jti: "jwt-1" })}.sig`;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let responseStatus: number;
let responseBody: Record<string, unknown>;
let seenBodies: unknown[];
let fakeHome: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/api/auth/token") {
        return Response.json({ token: apiToken() });
      }
      seenBodies.push(await request.json());
      return Response.json(responseBody, { status: responseStatus });
    },
  });
  baseUrl = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server.stop(true);
});

beforeEach(() => {
  responseStatus = 200;
  responseBody = {};
  seenBodies = [];
  fakeHome = mkdtempSync(join(tmpdir(), "scarn-worker-launch-"));
  setHomeDirForTests(fakeHome);
  saveAuthProfile(baseUrl, { accessToken: "token-a", userId: USER_ID });
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(fakeHome, { recursive: true, force: true });
});

const register = async () => {
  const client = await createTaskPlaneWorkerClient(baseUrl, {
    resolveUserId: () => Promise.resolve(USER_ID),
  });
  if (!client.registerTaskRunManagedLaunch) {
    throw new Error("expected the client to register managed launches");
  }
  return await client.registerTaskRunManagedLaunch({
    taskRunId: TASK_ID,
    claimToken: "claim",
    ...urls,
  });
};

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to fail");
}

describe("createTaskPlaneWorkerClient managed launch", () => {
  test("sends the resolved URLs and returns the registered relay entries", async () => {
    const entries = {
      notion: { relayUrl: `${baseUrl}/api/mcp-relay/x`, capability: "cap" },
    };
    responseBody = { entries };

    expect(await register()).toEqual(entries);
    expect(seenBodies).toEqual([{ claimToken: "claim", ...urls }]);
  });

  test("maps a 409 MANAGED_CONNECTION_NOT_READY to ManagedConnectionNotReadyError", async () => {
    responseStatus = 409;
    responseBody = {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      code: "MANAGED_CONNECTION_NOT_READY",
      meta: {
        key: "notion",
        connection: "notion",
        state: "needs_reconnect",
        reasonCode: "refresh_failed",
      },
    };

    const error = await captureError(register());

    expect(error).toBeInstanceOf(ManagedConnectionNotReadyError);
    expect((error as ManagedConnectionNotReadyError).details).toEqual({
      key: "notion",
      state: "needs_reconnect",
      reasonCode: "refresh_failed",
    });
  });

  test("leaves another 409 as the problem error, so a revoked claim reads as cancelled", async () => {
    responseStatus = 409;
    responseBody = { type: "about:blank", title: "Conflict", status: 409 };

    const error = await captureError(register());

    expect(error).not.toBeInstanceOf(ManagedConnectionNotReadyError);
    expect(isTaskRunCancelledResponse(error)).toBe(true);
  });

  test("maps SCARN_MCP_CONNECTION_AUTH_INVALID to McpConnectionAuthRejectedError with the server's detail", async () => {
    const detail =
      'MCP server "notion" uses the project\'s "notion" connection, but its URL is not the connection\'s. Point it at https://mcp.notion.com/mcp.';
    responseStatus = 422;
    responseBody = {
      type: "about:blank",
      title: "Unprocessable Entity",
      status: 422,
      detail,
      code: "SCARN_MCP_CONNECTION_AUTH_INVALID",
      meta: {
        key: "notion",
        connection: "notion",
        expectedUrl: "https://mcp.notion.com/mcp",
      },
    };

    const error = await captureError(register());

    expect(error).toBeInstanceOf(McpConnectionAuthRejectedError);
    expect((error as Error).message).toBe(detail);
  });
});

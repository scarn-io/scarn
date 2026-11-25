/**
 * Unit tests for the step bridge's `/work-items/*` routes ({@link
 * WorkItemsBridge} behind {@link McpBridgeServer}) over real HTTP on loopback
 * with a fake API: forwarding with the claim token, the relayed answers and
 * errors, the body cap and the task-log line.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  STEP_BRIDGE_WORK_ITEMS_CREATE_PATH,
  STEP_BRIDGE_WORK_ITEMS_SOURCE_CURSOR_PATH,
  STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH,
  stepBridgeErrorResponseSchema,
} from "@scarn/sdk/contracts/step-bridge";
import { McpBridge } from "../../../../src/runtime/mcp-bridge/application/mcp-bridge";
import { WorkItemsBridge } from "../../../../src/runtime/mcp-bridge/application/work-items-bridge";
import {
  MAX_WORK_ITEMS_BRIDGE_REQUEST_BYTES,
  McpBridgeServer,
} from "../../../../src/runtime/mcp-bridge/infra";
import type { TaskRunWorkItemsApiResponse } from "../../../../src/work/task-run/contracts/process-project-work-types";
import { createFakePool } from "./helpers/fake-mcp-connection-pool";

const TOKEN = "bridge-test-token-0123456789abcdef";
const CLAIM_TOKEN = "claim-token-secret";
const TASK_RUN_ID = "0190a000-0000-7000-8000-000000000001";

type Answer = () => Promise<TaskRunWorkItemsApiResponse>;

const answer =
  (status: number, body: object): Answer =>
  () =>
    Promise.resolve({ status, body });

function fakeApi(
  answers: {
    upsert?: Answer;
    create?: Answer;
    sourceCursor?: Answer;
  } = {},
) {
  return {
    upsertTaskRunWorkItems: mockAnswer(
      answers.upsert ??
        answer(200, {
          items: [],
          counts: { created: 12, updated: 20, unchanged: 5 },
        }),
    ),
    createTaskRunWorkItem: mockAnswer(
      answers.create ?? answer(201, { workItemId: "wi-1", created: true }),
    ),
    latestTaskRunSourceUpdate: mockAnswer(
      answers.sourceCursor ??
        answer(200, { sourceUpdatedAt: "2026-11-01T00:00:00.000Z" }),
    ),
  };
}

function mockAnswer(impl: Answer) {
  return vi.fn<(input: object) => Promise<TaskRunWorkItemsApiResponse>>(impl);
}

let server: McpBridgeServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function start(
  api: ReturnType<typeof fakeApi> | null = fakeApi(),
  now?: () => number,
) {
  const logger = { debug: vi.fn(), log: vi.fn(), error: vi.fn() };
  const bridge = new McpBridge({
    servers: {},
    placement: { kind: "host", workspaceDir: "/workspace" },
    env: {},
    poolFactory: createFakePool(() => Promise.reject(new Error("no MCP calls")))
      .factory,
    signal: new AbortController().signal,
  });
  server = new McpBridgeServer({
    bridge,
    workItems: api
      ? new WorkItemsBridge({
          taskRunId: TASK_RUN_ID,
          claimToken: CLAIM_TOKEN,
          api,
          logger,
          now,
        })
      : undefined,
    token: TOKEN,
    bindAddress: "127.0.0.1",
  });
  const baseUrl = `http://127.0.0.1:${String(await server.start())}`;
  return { baseUrl, logger };
}

function post(
  baseUrl: string,
  pathname: string,
  body: string | Record<string, unknown>,
  authorization: string | null = `Bearer ${TOKEN}`,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authorization !== null) headers["Authorization"] = authorization;
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ITEM = {
  platform: "github",
  platformKey: "acme/repo#1",
  title: "Bug",
  description: "It breaks",
  sourceUpdatedAt: "2026-11-02T00:00:00.000Z",
};

function logLines(logger: { log: ReturnType<typeof vi.fn> }): string[] {
  return logger.log.mock.calls.map((call) => String(call[1]));
}

describe("step bridge work-item routes", () => {
  test("upsert forwards the items with the claim token, answers the API's body and logs the counts", async () => {
    const api = fakeApi();
    let tick = 1_000;
    const { baseUrl, logger } = await start(api, () => {
      tick += 1_200;
      return tick;
    });

    const response = await post(baseUrl, STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH, {
      items: [ITEM],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [],
      counts: { created: 12, updated: 20, unchanged: 5 },
    });
    expect(api.upsertTaskRunWorkItems).toHaveBeenCalledWith({
      taskRunId: TASK_RUN_ID,
      claimToken: CLAIM_TOKEN,
      items: [ITEM],
    });
    expect(logLines(logger)).toEqual([
      "work-items: upsert 1 (12 created, 20 updated, 5 unchanged) in 1.2s",
    ]);
  });

  test("create adds a UUIDv7 workItemId and project scope, and answers 200 for the API's 201", async () => {
    const api = fakeApi();
    const { baseUrl } = await start(api);

    const response = await post(baseUrl, STEP_BRIDGE_WORK_ITEMS_CREATE_PATH, {
      platformKey: "k-1",
      title: "Title",
      description: "Body",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workItemId: "wi-1",
      created: true,
    });
    const forwarded = api.createTaskRunWorkItem.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(forwarded).toMatchObject({
      taskRunId: TASK_RUN_ID,
      claimToken: CLAIM_TOKEN,
      scope: "project",
      platformKey: "k-1",
      title: "Title",
      description: "Body",
    });
    expect(String(forwarded["workItemId"])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/,
    );
  });

  test("source-cursor forwards the source with the claim token", async () => {
    const api = fakeApi();
    const { baseUrl } = await start(api);

    const response = await post(
      baseUrl,
      STEP_BRIDGE_WORK_ITEMS_SOURCE_CURSOR_PATH,
      { platform: "jira", keyPrefix: "ACME-" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sourceUpdatedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(api.latestTaskRunSourceUpdate).toHaveBeenCalledWith({
      taskRunId: TASK_RUN_ID,
      claimToken: CLAIM_TOKEN,
      platform: "jira",
      keyPrefix: "ACME-",
    });
  });

  test("relays the API's status, code and meta", async () => {
    const api = fakeApi({
      upsert: answer(422, {
        type: "about:blank",
        title: "Unprocessable",
        status: 422,
        detail: "No create grant covers acme/repo#1",
        code: "WORK_ITEM_GRANT_MISSING",
        meta: { refused: [{ platformKey: "acme/repo#1", action: "create" }] },
      }),
    });
    const { baseUrl, logger } = await start(api);

    const response = await post(baseUrl, STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH, {
      items: [ITEM],
    });

    expect(response.status).toBe(422);
    const body = stepBridgeErrorResponseSchema.parse(await response.json());
    expect(body).toEqual({
      error: "No create grant covers acme/repo#1",
      code: "WORK_ITEM_GRANT_MISSING",
      meta: { refused: [{ platformKey: "acme/repo#1", action: "create" }] },
    });
    expect(logLines(logger)[0]).toMatch(
      /^work-items: upsert 1 failed in \d+\.\ds \(HTTP 422 WORK_ITEM_GRANT_MISSING\)$/,
    );
  });

  test("answers 502 when the API can't be reached", async () => {
    const api = fakeApi({
      sourceCursor: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    const { baseUrl } = await start(api);

    const response = await post(
      baseUrl,
      STEP_BRIDGE_WORK_ITEMS_SOURCE_CURSOR_PATH,
      { platform: "custom" },
    );

    expect(response.status).toBe(502);
    expect(
      stepBridgeErrorResponseSchema.safeParse(await response.json()).success,
    ).toBe(true);
  });

  test("answers 502 when the session has no work-item bridge", async () => {
    const { baseUrl } = await start(null);
    const response = await post(baseUrl, STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH, {
      items: [ITEM],
    });
    expect(response.status).toBe(502);
  });

  test("rejects a missing token with 401 before forwarding", async () => {
    const api = fakeApi();
    const { baseUrl } = await start(api);
    const response = await post(
      baseUrl,
      STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH,
      { items: [ITEM] },
      null,
    );
    expect(response.status).toBe(401);
    expect(api.upsertTaskRunWorkItems).not.toHaveBeenCalled();
  });

  test("answers 400 for an invalid body without forwarding", async () => {
    const api = fakeApi();
    const { baseUrl } = await start(api);
    const duplicate = await post(baseUrl, STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH, {
      items: [ITEM, ITEM],
    });
    const notJson = await post(
      baseUrl,
      STEP_BRIDGE_WORK_ITEMS_CREATE_PATH,
      "{nope",
    );
    expect(duplicate.status).toBe(400);
    expect(notJson.status).toBe(400);
    expect(api.upsertTaskRunWorkItems).not.toHaveBeenCalled();
    expect(api.createTaskRunWorkItem).not.toHaveBeenCalled();
  });

  test("accepts a body over the MCP cap but answers 413 over 5 MiB", async () => {
    const api = fakeApi();
    const { baseUrl } = await start(api);
    const twoMiB = "x".repeat(2 * 1024 * 1024);

    const accepted = await post(baseUrl, STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH, {
      items: [{ ...ITEM, description: twoMiB }],
    });
    const tooLarge = await post(baseUrl, STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH, {
      items: [
        {
          ...ITEM,
          description: "x".repeat(MAX_WORK_ITEMS_BRIDGE_REQUEST_BYTES),
        },
      ],
    });

    expect(accepted.status).toBe(200);
    expect(tooLarge.status).toBe(413);
    expect(api.upsertTaskRunWorkItems).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, test } from "bun:test";
import {
  STEP_BRIDGE_TOKEN_ENV,
  STEP_BRIDGE_URL_ENV,
  STEP_BRIDGE_WORK_ITEMS_CREATE_PATH,
  STEP_BRIDGE_WORK_ITEMS_SOURCE_CURSOR_PATH,
  STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH,
  stepBridgeUpsertRequestSchema,
} from "../src/contracts/step-bridge";
import {
  createCodeStepWorkItemsClient,
  Features,
  isStepError,
  WorkItemsInvalidError,
  WorkItemsRefusedError,
  WorkItemsUnavailableError,
  type Grant,
  type WorkItemsBridgeFetch,
} from "../src/definitions/steps";

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

const ENV = {
  [STEP_BRIDGE_URL_ENV]: "http://host.docker.internal:4555/",
  [STEP_BRIDGE_TOKEN_ENV]: "secret-token",
};

type Recorded = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response): {
  fetch: WorkItemsBridgeFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(respond());
    },
  };
}

const grants = [
  Features.workItems.read({ scope: "project" })._grant,
  Features.workItems.create({ scope: "project", labels: ["acme"] })._grant,
] as const;

function sentBody(call: Recorded | undefined): unknown {
  if (typeof call?.init.body !== "string")
    throw new Error("expected a JSON body");
  return JSON.parse(call.init.body);
}

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const upsertItem = {
  platform: "custom",
  platformKey: "acme:1",
  title: "One",
  description: "Body",
  sourceUpdatedAt: "2026-11-01T00:00:00Z",
} as const;

describe("createCodeStepWorkItemsClient", () => {
  test("has only the methods its grants allow", () => {
    const readOnly = createCodeStepWorkItemsClient(
      [{ resource: "workItem", action: "read", scope: "project" }] as Grant[],
      { env: ENV },
    );
    expect(Object.keys(readOnly)).toEqual(["latestSourceUpdate"]);
  });

  test("upsert posts the items with the bearer token and returns the written items", async () => {
    const written = [
      {
        workItemId: "0190a000-0000-7000-8000-000000000001",
        platform: "custom",
        platformKey: "acme:1",
        outcome: "created" as const,
      },
    ];
    const { fetch, calls } = fakeFetch(() =>
      json({
        items: written,
        counts: { created: 1, updated: 0, unchanged: 0 },
      }),
    );
    const client = createCodeStepWorkItemsClient(grants, { env: ENV, fetch });
    expect(await client.upsert([upsertItem])).toEqual(written);
    expect(calls[0]?.url).toBe(
      `http://host.docker.internal:4555${STEP_BRIDGE_WORK_ITEMS_UPSERT_PATH}`,
    );
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer secret-token",
    );
    const body: unknown = sentBody(calls[0]);
    expect(stepBridgeUpsertRequestSchema.parse(body)).toEqual({
      items: [upsertItem],
    });
    expect(body).not.toHaveProperty("claimToken");
  });

  test("create and latestSourceUpdate post to their paths", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        workItemId: "0190a000-0000-7000-8000-000000000001",
        created: true,
        sourceUpdatedAt: "2026-11-01T00:00:00.000Z",
      }),
    );
    const client = createCodeStepWorkItemsClient(grants, { env: ENV, fetch });
    await client.create({
      platformKey: "acme:1",
      title: "One",
      description: "Body",
    });
    expect(
      await client.latestSourceUpdate({
        platform: "custom",
        keyPrefix: "acme:",
      }),
    ).toBe("2026-11-01T00:00:00.000Z");
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      STEP_BRIDGE_WORK_ITEMS_CREATE_PATH,
      STEP_BRIDGE_WORK_ITEMS_SOURCE_CURSOR_PATH,
    ]);
    expect(sentBody(calls[1])).toEqual({
      platform: "custom",
      keyPrefix: "acme:",
    });
  });

  test("invalid arguments throw before any request", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const client = createCodeStepWorkItemsClient(grants, { env: ENV, fetch });
    const error = await failure(
      client.upsert([{ ...upsertItem, platform: "linear" as "custom" }]),
    );
    expect(error).toBeInstanceOf(WorkItemsInvalidError);
    expect(isStepError(error) && error.name).toBe("Scarn.ArgsError");
    expect(calls).toHaveLength(0);
  });

  test("without the bridge env it throws WorkItemsUnavailableError", async () => {
    const client = createCodeStepWorkItemsClient(grants, { env: {} });
    const error = await failure(client.upsert([upsertItem]));
    expect(error).toBeInstanceOf(WorkItemsUnavailableError);
    expect((error as WorkItemsUnavailableError).reason).toBe("no_bridge");
  });

  test.each([
    [
      422,
      {
        error: "no create grant",
        code: "WORK_ITEM_GRANT_MISSING",
        meta: { refused: 2 },
      },
      WorkItemsRefusedError,
      "Scarn.StepFailed",
    ],
    [
      403,
      { error: "forbidden", code: "PROJECT_FORBIDDEN" },
      WorkItemsRefusedError,
      "Scarn.StepFailed",
    ],
    [413, { error: "too large" }, WorkItemsInvalidError, "Scarn.ArgsError"],
    [
      422,
      { error: "bad url", code: "VALIDATION_ERROR" },
      WorkItemsInvalidError,
      "Scarn.ArgsError",
    ],
    [
      401,
      { error: "bad token" },
      WorkItemsUnavailableError,
      "Scarn.StepFailed",
    ],
    [502, { error: "api down" }, WorkItemsUnavailableError, "Scarn.StepFailed"],
  ] as const)(
    "maps HTTP %i to its error",
    async (status, body, errorClass, name) => {
      const { fetch } = fakeFetch(() => json(body, status));
      const client = createCodeStepWorkItemsClient(grants, { env: ENV, fetch });
      const error = await failure(client.upsert([upsertItem]));
      expect(error).toBeInstanceOf(errorClass);
      expect(error.name).toBe(name);
      if (error instanceof WorkItemsRefusedError && "meta" in body) {
        expect(error.refused).toBe(2);
      }
    },
  );

  test("a response it doesn't understand is unavailable", async () => {
    const { fetch } = fakeFetch(() => json({ nope: true }));
    const client = createCodeStepWorkItemsClient(grants, { env: ENV, fetch });
    expect(await failure(client.upsert([upsertItem]))).toBeInstanceOf(
      WorkItemsUnavailableError,
    );
  });
});

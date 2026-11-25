import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  createFakeWorkItems,
  Features,
  WorkItemsInvalidError,
  WorkItemsRefusedError,
  type WorkItemUpsertItem,
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

const item = (
  platformKey: string,
  sourceUpdatedAt: string,
  extra: Partial<WorkItemUpsertItem> = {},
): WorkItemUpsertItem => ({
  platform: "custom",
  platformKey,
  title: `Item ${platformKey}`,
  description: "Body",
  sourceUpdatedAt,
  ...extra,
});

const read = Features.workItems.read({ scope: "project" });
const create = Features.workItems.create({
  scope: "project",
  labels: ["acme"],
  keyPrefix: "acme:",
});
const update = Features.workItems.update({
  scope: "project",
  keyPrefix: "acme:",
});

describe("createFakeWorkItems: types", () => {
  test("has the methods the features allow", () => {
    const readOnly = createFakeWorkItems([read]);
    expectTypeOf(readOnly).toHaveProperty("latestSourceUpdate");
    // @ts-expect-error no create or update grant
    void readOnly.upsert;

    const updateOnly = createFakeWorkItems([update]);
    expectTypeOf(updateOnly).toHaveProperty("upsert");
    // @ts-expect-error no create grant
    void updateOnly.create;
  });
});

describe("createFakeWorkItems: upsert", () => {
  test("creates new keys, updates newer ones and skips stale ones", async () => {
    const workItems = createFakeWorkItems([create, update]);
    const first = await workItems.upsert([
      item("acme:1", "2026-11-01T00:00:00Z"),
      item("acme:2", "2026-11-01T00:00:00Z"),
    ]);
    expect(first.map((saved) => saved.outcome)).toEqual(["created", "created"]);

    const second = await workItems.upsert([
      item("acme:1", "2026-11-02T00:00:00Z", { state: "closed" }),
      item("acme:2", "2026-11-01T00:00:00Z"),
    ]);
    expect(second).toEqual([
      {
        workItemId: first[0]?.workItemId ?? "",
        platform: "custom",
        platformKey: "acme:1",
        outcome: "updated",
      },
    ]);
    expect(
      workItems
        .items()
        .map(({ platformKey, state }) => ({ platformKey, state })),
    ).toEqual([
      { platformKey: "acme:1", state: "closed" },
      { platformKey: "acme:2", state: "open" },
    ]);
  });

  test("a new key without create refuses the whole call", async () => {
    const workItems = createFakeWorkItems([update], {
      items: [item("acme:1", "2026-11-01T00:00:00Z")],
    });
    const error = await failure(
      workItems.upsert([
        item("acme:1", "2026-11-02T00:00:00Z"),
        item("acme:9", "2026-11-02T00:00:00Z"),
      ]),
    );
    expect(error).toBeInstanceOf(WorkItemsRefusedError);
    expect((error as WorkItemsRefusedError).apiCode).toBe(
      "WORK_ITEM_GRANT_MISSING",
    );
    expect(error.message).toContain("no create grant on project");
    expect(workItems.items()[0]?.sourceUpdatedAt).toBe("2026-11-01T00:00:00Z");
  });

  test("an existing key without update is refused", async () => {
    const workItems = createFakeWorkItems([create]);
    await workItems.upsert([item("acme:1", "2026-11-01T00:00:00Z")]);
    const error = await failure(
      workItems.upsert([item("acme:1", "2026-11-02T00:00:00Z")]),
    );
    expect(error.message).toContain("no update grant on project");
  });

  test("a key outside keyPrefix is refused", async () => {
    const workItems = createFakeWorkItems([create, update]);
    const error = await failure(
      workItems.upsert([item("other:1", "2026-11-01T00:00:00Z")]),
    );
    expect(error).toBeInstanceOf(WorkItemsRefusedError);
  });

  test("a label outside the grant is refused", async () => {
    const workItems = createFakeWorkItems([create]);
    const error = await failure(
      workItems.upsert([
        item("acme:1", "2026-11-01T00:00:00Z", { labels: ["bug"] }),
      ]),
    );
    expect(error.message).toContain("with labels bug");
  });

  test("the longest matching keyPrefix decides", async () => {
    const workItems = createFakeWorkItems([
      Features.workItems.create({ scope: "project", labels: ["any"] }),
      Features.workItems.create({
        scope: "project",
        labels: ["acme"],
        keyPrefix: "acme:",
      }),
    ]);
    const error = await failure(
      workItems.upsert([
        item("acme:1", "2026-11-01T00:00:00Z", { labels: ["any"] }),
      ]),
    );
    expect(error.message).toContain("covers acme");
  });

  test("invalid items throw WorkItemsInvalidError", async () => {
    const workItems = createFakeWorkItems([create]);
    expect(await failure(workItems.upsert([]))).toBeInstanceOf(
      WorkItemsInvalidError,
    );
    expect(
      await failure(
        workItems.upsert([
          item("acme:1", "2026-11-01T00:00:00Z"),
          item("acme:1", "2026-11-01T00:00:00Z"),
        ]),
      ),
    ).toBeInstanceOf(WorkItemsInvalidError);
    expect(
      await failure(workItems.upsert([item("acme:1", "yesterday")])),
    ).toBeInstanceOf(WorkItemsInvalidError);
  });
});

describe("createFakeWorkItems: create", () => {
  test("creates once per key", async () => {
    const workItems = createFakeWorkItems([create]);
    const first = await workItems.create({
      platformKey: "acme:1",
      title: "One",
      description: "Body",
      labels: ["acme"],
    });
    const again = await workItems.create({
      platformKey: "acme:1",
      title: "One",
      description: "Body",
    });
    expect(first.created).toBe(true);
    expect(again).toEqual({ workItemId: first.workItemId, created: false });
  });

  test("a key outside keyPrefix is refused", async () => {
    const workItems = createFakeWorkItems([create]);
    expect(
      await failure(
        workItems.create({
          platformKey: "other:1",
          title: "One",
          description: "Body",
        }),
      ),
    ).toBeInstanceOf(WorkItemsRefusedError);
  });
});

describe("createFakeWorkItems: latestSourceUpdate", () => {
  test("is the newest sourceUpdatedAt per platform and prefix", async () => {
    const workItems = createFakeWorkItems([read], {
      items: [
        item("acme:1", "2026-11-01T00:00:00Z"),
        item("acme:2", "2026-11-03T00:00:00Z"),
        item("beta:1", "2026-11-05T00:00:00Z"),
        item("acme:3", "2026-11-09T00:00:00Z", { platform: "jira" }),
      ],
    });
    expect(
      await workItems.latestSourceUpdate({
        platform: "custom",
        keyPrefix: "acme:",
      }),
    ).toBe("2026-11-03T00:00:00Z");
    expect(await workItems.latestSourceUpdate({ platform: "custom" })).toBe(
      "2026-11-05T00:00:00Z",
    );
    expect(
      await workItems.latestSourceUpdate({
        platform: "github",
      }),
    ).toBeNull();
  });
});

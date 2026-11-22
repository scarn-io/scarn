import { describe, expect, test } from "bun:test";
import { WorkItemEntity } from "@/work-items/work-item/domain/work-item-entity";
import { CoreValidationError } from "@/lib/errors";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const createdByUserId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f04");

const baseCreateProps = {
  projectId,
  platform: "scarn" as const,
  platformKey: "BOB-1",
  url: "https://example.com/work-items/BOB-1",
  title: "Original title",
  description: "Original description",
  sourceCreatedAt: "2026-04-22T09:00:00.000Z",
  sourceUpdatedAt: "2026-04-22T10:00:00.000Z",
  fields: { status: "open" },
  createdByUserId,
};

describe("work item entity", () => {
  test("create defaults to a generated id and normalizes fields", () => {
    const workItem = WorkItemEntity.create(baseCreateProps);

    expect(workItem.id).toBeString();
    expect(workItem.projectId).toBe(projectId);
    expect(workItem.platform).toBe("scarn");
    expect(workItem.platformKey).toBe("BOB-1");
    expect(workItem.title).toBe("Original title");
    expect(workItem.description).toBe("Original description");
    expect(workItem.createdByUserId).toBe(createdByUserId);
  });

  test("create defaults state to open and spawnedByTaskId to null", () => {
    const workItem = WorkItemEntity.create(baseCreateProps);

    expect(workItem.state).toBe("open");
    expect(workItem.spawnedByTaskId).toBeNull();
  });

  test("create keeps an explicit closed state", () => {
    const workItem = WorkItemEntity.create({
      ...baseCreateProps,
      state: "closed",
    });

    expect(workItem.state).toBe("closed");
  });

  test("a closed item without a closure gets a sync closure dated from the source", () => {
    const workItem = WorkItemEntity.create({
      ...baseCreateProps,
      state: "closed",
    });

    expect(workItem.closure).toEqual({
      reason: "completed",
      resolution: null,
      closedAt: new Date("2026-04-22T10:00:00.000Z"),
      closedByUserId: null,
      closedByTaskId: null,
    });
  });

  test("an open item can't carry a closure", () => {
    expect(() =>
      WorkItemEntity.create({
        ...baseCreateProps,
        closure: {
          reason: "completed",
          resolution: null,
          closedAt: "2026-04-22T10:00:00.000Z",
          closedByUserId: null,
          closedByTaskId: null,
        },
      }),
    ).toThrow(expect.objectContaining({ code: "WORK_ITEM_OPEN_WITH_CLOSURE" }));
  });

  test("close records the closure and reopen clears it", () => {
    const original = WorkItemEntity.create(baseCreateProps);
    const closedAt = new Date("2026-04-22T13:00:00.000Z");

    const closed = original.close(
      {
        reason: "out_of_scope",
        resolution: "  Not this quarter.  ",
        closedAt,
        closedByUserId: createdByUserId,
        closedByTaskId: null,
      },
      closedAt,
    );

    expect(closed.state).toBe("closed");
    expect(closed.closure).toEqual({
      reason: "out_of_scope",
      resolution: "Not this quarter.",
      closedAt,
      closedByUserId: createdByUserId,
      closedByTaskId: null,
    });
    expect(closed.updatedAt).toEqual(closedAt);
    expect(original.state).toBe("open");

    const reopenedAt = new Date("2026-04-22T14:00:00.000Z");
    const reopened = closed.reopen(reopenedAt);

    expect(reopened.state).toBe("open");
    expect(reopened.closure).toBeNull();
    expect(reopened.updatedAt).toEqual(reopenedAt);
  });

  test("close and reopen reject a no-op change", () => {
    const open = WorkItemEntity.create(baseCreateProps);
    const closed = WorkItemEntity.create({
      ...baseCreateProps,
      state: "closed",
    });

    expect(() => open.reopen()).toThrow(
      expect.objectContaining({ code: "WORK_ITEM_ALREADY_OPEN" }),
    );
    expect(() =>
      closed.close({
        reason: "completed",
        resolution: null,
        closedAt: new Date(),
        closedByUserId: null,
        closedByTaskId: null,
      }),
    ).toThrow(expect.objectContaining({ code: "WORK_ITEM_ALREADY_CLOSED" }));
  });

  test("a closure can't name both a user and a Task as the closer", () => {
    const open = WorkItemEntity.create(baseCreateProps);

    expect(() =>
      open.close({
        reason: "completed",
        resolution: null,
        closedAt: new Date(),
        closedByUserId: createdByUserId,
        closedByTaskId: parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f09"),
      }),
    ).toThrow(
      expect.objectContaining({ code: "WORK_ITEM_CLOSED_BY_CONFLICT" }),
    );
  });

  test("edit on a scarn-platform entity returns a new entity with updated title/description/updatedAt", () => {
    const original = WorkItemEntity.rehydrate({
      id: WorkItemEntity.create(baseCreateProps).id,
      ...baseCreateProps,
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
    });
    const now = new Date("2026-04-22T13:00:00.000Z");

    const edited = original.edit("Updated title", "Updated description", now);

    expect(edited).not.toBe(original);
    expect(edited.title).toBe("Updated title");
    expect(edited.description).toBe("Updated description");
    expect(edited.updatedAt).toEqual(now);

    // Everything else is unchanged.
    expect(edited.id).toBe(original.id);
    expect(edited.projectId).toBe(original.projectId);
    expect(edited.platform).toBe(original.platform);
    expect(edited.platformId).toBe(original.platformId);
    expect(edited.platformKey).toBe(original.platformKey);
    expect(edited.url).toBe(original.url);
    expect(edited.sourceCreatedAt).toEqual(original.sourceCreatedAt);
    expect(edited.sourceUpdatedAt).toEqual(original.sourceUpdatedAt);
    expect(edited.fields).toEqual(original.fields);
    expect(edited.createdByUserId).toBe(original.createdByUserId);
    expect(edited.createdAt).toEqual(original.createdAt);

    // Original is untouched.
    expect(original.title).toBe("Original title");
    expect(original.description).toBe("Original description");
  });

  test("edit on a non-scarn platform entity throws WORK_ITEM_NOT_EDITABLE_SYNCED", () => {
    const synced = WorkItemEntity.create({
      ...baseCreateProps,
      platform: "github",
    });

    expect(() => synced.edit("New title", "New description")).toThrow(
      CoreValidationError,
    );

    try {
      synced.edit("New title", "New description");
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe(
        "WORK_ITEM_NOT_EDITABLE_SYNCED",
      );
    }
  });

  test("labels are trimmed, deduplicated and keep their case and order", () => {
    const workItem = WorkItemEntity.create({
      ...baseCreateProps,
      labels: [" wayfinder:research ", "Bug", "bug", "wayfinder:research", " "],
    });

    expect(workItem.labels).toEqual(["wayfinder:research", "Bug", "bug"]);
  });

  test("addLabels adds new labels once and removeLabels drops them", () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const workItem = WorkItemEntity.create({
      ...baseCreateProps,
      labels: ["a"],
    });

    const added = workItem.addLabels([" b ", "a", "b"], now);
    expect(added.labels).toEqual(["a", "b"]);
    expect(added.updatedAt).toEqual(now);
    expect(workItem.labels).toEqual(["a"]);

    expect(added.removeLabels([" a ", "missing"], now).labels).toEqual(["b"]);
  });

  test("addLabels and removeLabels on a synced item throw WORK_ITEM_NOT_EDITABLE_SYNCED", () => {
    const synced = WorkItemEntity.create({
      ...baseCreateProps,
      platform: "github",
      labels: ["bug"],
    });

    for (const write of [
      () => synced.addLabels(["ux"]),
      () => synced.removeLabels(["bug"]),
    ]) {
      expect(write).toThrow(
        expect.objectContaining({ code: "WORK_ITEM_NOT_EDITABLE_SYNCED" }),
      );
    }
  });

  test("setParent sets a parent and bumps updatedAt, regardless of platform", () => {
    const parentId = WorkItemEntity.create(baseCreateProps).id;
    const original = WorkItemEntity.rehydrate({
      id: WorkItemEntity.create(baseCreateProps).id,
      ...baseCreateProps,
      platform: "github",
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
    });
    const now = new Date("2026-04-22T13:00:00.000Z");

    const reparented = original.setParent(parentId, now);

    expect(reparented).not.toBe(original);
    expect(reparented.parentWorkItemId).toBe(parentId);
    expect(reparented.updatedAt).toEqual(now);
    expect(original.parentWorkItemId).toBeNull();
  });

  test("setParent(null) clears an existing parent", () => {
    const parentId = WorkItemEntity.create(baseCreateProps).id;
    const original = WorkItemEntity.rehydrate({
      id: WorkItemEntity.create(baseCreateProps).id,
      ...baseCreateProps,
      parentWorkItemId: parentId,
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
    });
    const now = new Date("2026-04-22T13:00:00.000Z");

    const cleared = original.setParent(null, now);

    expect(cleared.parentWorkItemId).toBeNull();
    expect(cleared.updatedAt).toEqual(now);
    expect(original.parentWorkItemId).toBe(parentId);
  });

  test("setParent rejects a work item being set as its own parent", () => {
    const original = WorkItemEntity.create(baseCreateProps);

    expect(() => original.setParent(original.id)).toThrow(CoreValidationError);

    try {
      original.setParent(original.id);
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe("WORK_ITEM_SELF_PARENT");
    }
  });
});

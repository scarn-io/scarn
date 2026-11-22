import { describe, expect, test } from "bun:test";
import { WorkItemBlockEntity } from "@/work-items/work-item-block/domain/work-item-block-entity";
import { CoreValidationError } from "@/lib/errors";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a2f02");
const blockedWorkItemId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a2f03");
const blockingWorkItemId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a2f04");
const createdByUserId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a2f05");

const baseCreateProps = {
  projectId,
  blockedWorkItemId,
  blockingWorkItemId,
  createdByUserId,
};

describe("work item block entity", () => {
  test("throws WORK_ITEM_SELF_BLOCK when blockedWorkItemId equals blockingWorkItemId", () => {
    expect(() =>
      WorkItemBlockEntity.create({
        ...baseCreateProps,
        blockingWorkItemId: blockedWorkItemId,
      }),
    ).toThrow(CoreValidationError);

    try {
      WorkItemBlockEntity.create({
        ...baseCreateProps,
        blockingWorkItemId: blockedWorkItemId,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe("WORK_ITEM_SELF_BLOCK");
    }
  });

  test("create generates an id and persists the given fields", () => {
    const block = WorkItemBlockEntity.create(baseCreateProps);

    expect(block.id).toBeString();
    expect(block.projectId).toBe(projectId);
    expect(block.blockedWorkItemId).toBe(blockedWorkItemId);
    expect(block.blockingWorkItemId).toBe(blockingWorkItemId);
    expect(block.createdByUserId).toBe(createdByUserId);
  });

  test("create defaults createdByUserId to null when omitted", () => {
    const block = WorkItemBlockEntity.create({
      projectId,
      blockedWorkItemId,
      blockingWorkItemId,
    });

    expect(block.createdByUserId).toBeNull();
  });

  test("rehydrate preserves persisted fields", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    const block = WorkItemBlockEntity.rehydrate({
      id: "0196917c-532c-75aa-b7d5-0a84b71a2f06" as never,
      projectId,
      blockedWorkItemId,
      blockingWorkItemId,
      createdByUserId,
      createdAt: now,
    });

    expect(block.blockedWorkItemId).toBe(blockedWorkItemId);
    expect(block.blockingWorkItemId).toBe(blockingWorkItemId);
    expect(block.createdAt).toEqual(now);
  });
});

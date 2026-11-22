import { describe, expect, test } from "bun:test";
import {
  workItemEntityToContract,
  upsertWorkItemInputToCreateWorkItemProps,
} from "@/work-items/work-item/application/work-item-contract-mapper";
import { WorkItemEntity } from "@/work-items/work-item/domain/work-item-entity";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");

describe("work item contract mapper", () => {
  test("maps flattened upsert input into create props", () => {
    expect(
      upsertWorkItemInputToCreateWorkItemProps({
        projectId,
        platform: "github",
        platformId: "12345",
        platformKey: "#46",
        url: "https://github.com/acme/repo/issues/46",
        title: "Login fails",
        description: "Users cannot log in after deploy",
        sourceCreatedAt: "2026-04-22T11:00:00.000Z",
        sourceUpdatedAt: "2026-04-22T12:00:00.000Z",
        fields: {
          status: "open",
          metadata: {
            priority: "high",
            tags: ["customer", "prod"],
          },
        },
      }),
    ).toEqual({
      projectId,
      platform: "github",
      platformId: "12345",
      platformKey: "#46",
      url: "https://github.com/acme/repo/issues/46",
      title: "Login fails",
      description: "Users cannot log in after deploy",
      sourceCreatedAt: "2026-04-22T11:00:00.000Z",
      sourceUpdatedAt: "2026-04-22T12:00:00.000Z",
      fields: {
        status: "open",
        metadata: {
          priority: "high",
          tags: ["customer", "prod"],
        },
      },
    });
  });

  test("falls back to placeholder when description is null", () => {
    const workItem = WorkItemEntity.rehydrate({
      id: parseWorkItemId("0196917c-532c-75aa-b7d5-0a84b71a1f03"),
      projectId,
      platform: "jira",
      platformKey: "ENG-125",
      title: "Missing description",
      description: null,
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
    });
    const contract = workItemEntityToContract(workItem);
    expect(contract.description).toBe("(No description provided.)");
  });

  test("maps work item entities back to the flattened contract", () => {
    const workItem = WorkItemEntity.rehydrate({
      id: parseWorkItemId("0196917c-532c-75aa-b7d5-0a84b71a1f01"),
      projectId,
      platform: "jira",
      platformId: null,
      platformKey: "ENG-124",
      url: "https://jira.example.com/browse/ENG-124",
      title: "Persist nested fields",
      description: "Nested fields stay nested",
      sourceCreatedAt: "2026-04-22T09:00:00.000Z",
      sourceUpdatedAt: "2026-04-22T10:00:00.000Z",
      fields: {
        status: "open",
        metadata: {
          priority: "high",
          retryCount: 3,
        },
      },
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:05:00.000Z",
    });
    const contract = workItemEntityToContract(workItem);

    expect(contract).toEqual({
      id: contract.id,
      projectId,
      platform: "jira",
      platformId: null,
      platformKey: "ENG-124",
      url: "https://jira.example.com/browse/ENG-124",
      title: "Persist nested fields",
      description: "Nested fields stay nested",
      descriptionVersion: 1,
      sourceCreatedAt: "2026-04-22T09:00:00.000Z",
      sourceUpdatedAt: "2026-04-22T10:00:00.000Z",
      fields: {
        status: "open",
        metadata: {
          priority: "high",
          retryCount: 3,
        },
      },
      labels: [],
      createdByUserId: null,
      createdByUsername: null,
      createdByImage: null,
      assigneeUserId: null,
      parentWorkItemId: null,
      state: "open",
      closeReason: null,
      resolution: null,
      closedAt: null,
      closedByUserId: null,
      closedByTaskId: null,
      spawnedByTaskId: null,
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:05:00.000Z",
    });
  });

  test("maps resolved creator username and image onto the contract", () => {
    const workItem = WorkItemEntity.rehydrate({
      id: parseWorkItemId("0196917c-532c-75aa-b7d5-0a84b71a1f04"),
      projectId,
      platform: "scarn",
      platformKey: "BOB-1",
      title: "Created in Scarn",
      description: "Has a creator",
      createdByUserId: parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f05"),
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
    });
    const contract = workItemEntityToContract(
      workItem,
      "alice",
      "https://example.com/alice.png",
    );

    expect(contract.createdByUsername).toBe("alice");
    expect(contract.createdByImage).toBe("https://example.com/alice.png");
  });

  test("maps the assignee onto the contract", () => {
    const assigneeUserId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f06");
    const workItem = WorkItemEntity.rehydrate({
      id: parseWorkItemId("0196917c-532c-75aa-b7d5-0a84b71a1f07"),
      projectId,
      platform: "scarn",
      platformKey: "BOB-2",
      title: "Assigned",
      assigneeUserId,
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:00:00.000Z",
    });

    expect(workItemEntityToContract(workItem).assigneeUserId).toBe(
      assigneeUserId,
    );
  });
});

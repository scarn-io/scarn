import { beforeAll, describe, expect, test } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import {
  createTestUserAndSession,
  type TestUserAndSession,
} from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemContract } from "@/work-items/work-item/contracts/work-item-contracts";

describe("work item block lifecycle", () => {
  const now = new Date("2026-05-01T12:00:00.000Z");
  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(now),
  });
  const app = createApp(appContext);
  const apiClient = createScarnTreaty(app);

  const callCreate = (
    input: { blockedWorkItemId: string; blockingWorkItemId: string },
    headers: { authorization: string },
  ) =>
    apiClient.api["work-item-blocks"].post(
      {
        blockedWorkItemId: parseWorkItemId(input.blockedWorkItemId),
        blockingWorkItemId: parseWorkItemId(input.blockingWorkItemId),
      },
      { headers },
    );

  const callDelete = (blockId: string, headers: { authorization: string }) =>
    apiClient.api["work-item-blocks"]({ blockId }).delete(undefined, {
      headers,
    });

  const callList = (workItemId: string, headers: { authorization: string }) =>
    apiClient.api["work-item-blocks"].get({
      query: { workItemId: parseWorkItemId(workItemId) },
      headers,
    });

  const createWorkItem = async (
    owner: { authHeaders: { authorization: string } },
    project: ProjectContract,
    title: string,
  ): Promise<WorkItemContract> =>
    await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "scarn",
          platformId: null,
          platformKey: `manual-${uuidv7()}`,
          url: null,
          title,
          description: `Description for ${title}`,
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

  let owner: TestUserAndSession | undefined;
  let project: ProjectContract | undefined;
  let blockedItem: WorkItemContract | undefined;
  let blockingItem: WorkItemContract | undefined;
  let blockId: UuidV7 | undefined;

  beforeAll(async () => {
    owner = await createTestUserAndSession({
      email: `work-item-block-lifecycle-${crypto.randomUUID()}@example.com`,
    });
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Block Lifecycle Project",
          description: "Project for work item block lifecycle tests",
          gitUrl: "https://github.com/example/work-item-block-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    blockedItem = await createWorkItem(owner, project, "Blocked item");
    blockingItem = await createWorkItem(owner, project, "Blocking item");
  });

  test("creates a block", async () => {
    if (!owner || !blockedItem || !blockingItem) {
      throw new Error("Expected lifecycle setup to complete");
    }

    const block = await unwrapAsync(
      callCreate(
        {
          blockedWorkItemId: blockedItem.id,
          blockingWorkItemId: blockingItem.id,
        },
        owner.authHeaders,
      ),
    );

    expect(block.blockedWorkItemId).toBe(parseUuidV7(blockedItem.id));
    expect(block.blockingWorkItemId).toBe(parseUuidV7(blockingItem.id));
    expect(block.projectId).toBe(parseUuidV7(project?.id ?? ""));
    expect(block.createdByUserId).toBe(parseUuidV7(owner.userId));
    blockId = block.id;
  });

  test("lists the block under blockedBy for the blocked item", async () => {
    if (!owner || !blockedItem || !blockingItem || !blockId) {
      throw new Error("Expected lifecycle setup to complete");
    }

    const result = await unwrapAsync(
      callList(blockedItem.id, owner.authHeaders),
    );

    expect(result.blockedBy).toHaveLength(1);
    expect(result.blockedBy[0]?.id).toBe(blockId);
    expect(result.blockedBy[0]?.blockingWorkItemId).toBe(
      parseUuidV7(blockingItem.id),
    );
    expect(result.blocking).toHaveLength(0);
  });

  test("lists the block under blocking for the blocking item", async () => {
    if (!owner || !blockedItem || !blockingItem || !blockId) {
      throw new Error("Expected lifecycle setup to complete");
    }

    const result = await unwrapAsync(
      callList(blockingItem.id, owner.authHeaders),
    );

    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]?.id).toBe(blockId);
    expect(result.blocking[0]?.blockedWorkItemId).toBe(
      parseUuidV7(blockedItem.id),
    );
    expect(result.blockedBy).toHaveLength(0);
  });

  test("deletes the block", async () => {
    if (!owner || !blockId) {
      throw new Error("Expected lifecycle setup to complete");
    }

    const deletedCount = await unwrapAsync(callDelete(blockId, owner.authHeaders));

    expect(deletedCount).toBe(1);
  });

  test("lists no blocks in either direction after deletion", async () => {
    if (!owner || !blockedItem || !blockingItem) {
      throw new Error("Expected lifecycle setup to complete");
    }

    const blockedResult = await unwrapAsync(
      callList(blockedItem.id, owner.authHeaders),
    );
    const blockingResult = await unwrapAsync(
      callList(blockingItem.id, owner.authHeaders),
    );

    expect(blockedResult.blockedBy).toHaveLength(0);
    expect(blockingResult.blocking).toHaveLength(0);
  });
});

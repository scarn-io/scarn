import { beforeAll, describe, expect } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { parseWorkItemBlockId } from "@/work-items/work-item-block/domain/work-item-block-id";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import {
  createTestUserAndSession,
  type TestUserAndSession,
} from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { WorkItemContract } from "@/work-items/work-item/contracts/work-item-contracts";

describe("create work item block", () => {
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

  const createProject = async (
    owner: { authHeaders: { authorization: string } },
    name: string,
  ) =>
    await unwrapAsync(
      apiClient.api.projects.post(
        {
          name,
          description: `Project for ${name}`,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

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

  beforeAll(async () => {
    owner = await createTestUserAndSession({
      email: `work-item-block-post-${crypto.randomUUID()}@example.com`,
    });
    project = await createProject(owner, "Work Item Block Post Project");
  });

  concurrentTest(
    "rejects a blocking item that belongs to a different project",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const otherProject = await createProject(
        owner,
        "Other Project For Cross-Project Block Rejection",
      );
      const blockedItem = await createWorkItem(
        owner,
        project,
        "Cross-project blocked item",
      );
      const foreignBlockingItem = await createWorkItem(
        owner,
        otherProject,
        "Foreign blocking item",
      );

      const { data, error } = await callCreate(
        {
          blockedWorkItemId: blockedItem.id,
          blockingWorkItemId: foreignBlockingItem.id,
        },
        owner.authHeaders,
      );

      expect(data).toBeFalsy();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        code: "WORK_ITEM_BLOCK_CROSS_PROJECT",
      });
    },
  );

  concurrentTest("rejects a work item blocking itself", async () => {
    if (!owner || !project) {
      throw new Error("Expected project auth setup to complete");
    }

    const workItem = await createWorkItem(owner, project, "Self block item");

    const { data, error } = await callCreate(
      {
        blockedWorkItemId: workItem.id,
        blockingWorkItemId: workItem.id,
      },
      owner.authHeaders,
    );

    expect(data).toBeFalsy();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "WORK_ITEM_SELF_BLOCK" });
  });

  concurrentTest(
    "rejects a direct reciprocal pair (a 2-node cycle)",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const itemX = await createWorkItem(owner, project, "Reciprocal item X");
      const itemY = await createWorkItem(owner, project, "Reciprocal item Y");

      // Y blocks X.
      await unwrapAsync(
        callCreate(
          { blockedWorkItemId: itemX.id, blockingWorkItemId: itemY.id },
          owner.authHeaders,
        ),
      );

      // X blocks Y would close a direct 2-cycle.
      const { data, error } = await callCreate(
        { blockedWorkItemId: itemY.id, blockingWorkItemId: itemX.id },
        owner.authHeaders,
      );

      expect(data).toBeFalsy();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        code: "WORK_ITEM_BLOCK_RECIPROCAL",
      });
    },
  );

  concurrentTest(
    "rejects a 3-node transitive cycle",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const itemA = await createWorkItem(owner, project, "Cycle item A");
      const itemB = await createWorkItem(owner, project, "Cycle item B");
      const itemC = await createWorkItem(owner, project, "Cycle item C");

      // A blocks B (B depends on A).
      await unwrapAsync(
        callCreate(
          { blockedWorkItemId: itemB.id, blockingWorkItemId: itemA.id },
          owner.authHeaders,
        ),
      );
      // B blocks C (C depends on B).
      await unwrapAsync(
        callCreate(
          { blockedWorkItemId: itemC.id, blockingWorkItemId: itemB.id },
          owner.authHeaders,
        ),
      );

      // C blocks A would close the cycle A -> B -> C -> A.
      const { data, error } = await callCreate(
        { blockedWorkItemId: itemA.id, blockingWorkItemId: itemC.id },
        owner.authHeaders,
      );

      expect(data).toBeFalsy();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({ code: "WORK_ITEM_BLOCK_CYCLE" });
    },
  );

  concurrentTest(
    "does not false-positive on an unrelated, disconnected graph",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const itemD = await createWorkItem(owner, project, "Unrelated item D");
      const itemE = await createWorkItem(owner, project, "Unrelated item E");
      const itemF = await createWorkItem(owner, project, "Unrelated item F");
      const itemG = await createWorkItem(owner, project, "Unrelated item G");

      // D blocks E — an unrelated chain elsewhere in the same project.
      await unwrapAsync(
        callCreate(
          { blockedWorkItemId: itemE.id, blockingWorkItemId: itemD.id },
          owner.authHeaders,
        ),
      );

      // F blocks G is a legitimate, disconnected new block and must succeed.
      const block = await unwrapAsync(
        callCreate(
          { blockedWorkItemId: itemG.id, blockingWorkItemId: itemF.id },
          owner.authHeaders,
        ),
      );

      expect(block.blockedWorkItemId).toBe(itemG.id);
      expect(block.blockingWorkItemId).toBe(itemF.id);
    },
  );

  concurrentTest(
    "the work_item_blocks row is cascade-deleted when the blocked item is deleted",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const blockedItem = await createWorkItem(
        owner,
        project,
        "Cascade-delete blocked item",
      );
      const blockingItem = await createWorkItem(
        owner,
        project,
        "Cascade-delete blocking item (survives)",
      );

      const block = await unwrapAsync(
        callCreate(
          {
            blockedWorkItemId: blockedItem.id,
            blockingWorkItemId: blockingItem.id,
          },
          owner.authHeaders,
        ),
      );

      await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: blockedItem.id }).delete(
          undefined,
          { headers: { ...owner.authHeaders } },
        ),
      );

      // Kept on direct repo access rather than the API client: there is no
      // "get block by id" endpoint (only list-by-work-item and delete), so
      // this is the only way to observe the cascading delete without adding
      // new API surface out of scope for this ticket.
      const reloaded = await appContext.workItemBlockRepo.load(
        parseWorkItemBlockId(block.id),
      );
      expect(reloaded).toBeNull();
    },
  );

  concurrentTest(
    "the work_item_blocks row is cascade-deleted when the blocking item is deleted",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const blockedItem = await createWorkItem(
        owner,
        project,
        "Cascade-delete blocked item (survives)",
      );
      const blockingItem = await createWorkItem(
        owner,
        project,
        "Cascade-delete blocking item",
      );

      const block = await unwrapAsync(
        callCreate(
          {
            blockedWorkItemId: blockedItem.id,
            blockingWorkItemId: blockingItem.id,
          },
          owner.authHeaders,
        ),
      );

      await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: blockingItem.id }).delete(
          undefined,
          { headers: { ...owner.authHeaders } },
        ),
      );

      // Same rationale as the blocked-item cascade case above: no "get block
      // by id" endpoint exists, so direct repo access is the only way to
      // observe the deletion.
      const reloaded = await appContext.workItemBlockRepo.load(
        parseWorkItemBlockId(block.id),
      );
      expect(reloaded).toBeNull();
    },
  );

  concurrentTest(
    "rejects a caller who lacks work-items:write on the target's project",
    async () => {
      if (!owner || !project) {
        throw new Error("Expected project auth setup to complete");
      }

      const outsider = await createTestUserAndSession({
        email: `work-item-block-outsider-${crypto.randomUUID()}@example.com`,
      });
      const blockedItem = await createWorkItem(
        owner,
        project,
        "Guarded blocked item",
      );
      const blockingItem = await createWorkItem(
        owner,
        project,
        "Guarded blocking item",
      );

      const { data, error } = await callCreate(
        {
          blockedWorkItemId: blockedItem.id,
          blockingWorkItemId: blockingItem.id,
        },
        outsider.authHeaders,
      );

      expect(data).toBeFalsy();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({ code: "PROJECT_FORBIDDEN" });
    },
  );
});

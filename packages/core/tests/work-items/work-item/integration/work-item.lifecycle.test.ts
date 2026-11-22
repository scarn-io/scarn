import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { createAppContext } from "@/lib/di";
import {
  parseWorkItemId,
  type WorkItemId,
} from "@/work-items/work-item/domain/work-item-id";
import { fixedTimeProvider, serialTest, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";

describe("work item lifecycle plan", () => {
  let createdSingleId: WorkItemId | undefined;
  let createdManyIds: WorkItemId[] | undefined;
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  beforeAll(async () => {
    const owner = await createTestUserAndSession({ email: `work-item-lifecycle-${crypto.randomUUID()}@example.com` });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Lifecycle Project",
          description: "Project for work item lifecycle tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );
  });

  serialTest("creates one work item", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const createdSingle = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "github",
          platformId: "lifecycle-single",
          platformKey: "#100",
          url: "https://github.com/acme/repo/issues/100",
          title: "Create one work item",
          description: "Initial single-work-item description",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: {
            status: "open",
            priority: "high",
          },
        },
        { headers: { ...authHeaders } },
      ),
    );
    createdSingleId = parseWorkItemId(createdSingle.id);

    expect(createdSingle.title).toBe("Create one work item");
  });

  serialTest("creates multiple work items", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }

    const createdMany = await unwrapAsync(
      apiClient.api["work-items"].batch.post(
        [
          {
            projectId: project.id,
            platform: "jira",
            platformId: "lifecycle-many-1",
            platformKey: "ENG-101",
            title: "Create many work item 1",
            description: "First batch work item",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {
              status: "todo",
            },
          },
          {
            projectId: project.id,
            platform: "jira",
            platformId: "lifecycle-many-2",
            platformKey: "ENG-102",
            title: "Create many work item 2",
            description: "Second batch work item",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {
              status: "todo",
            },
          },
        ],
        { headers: { ...authHeaders } },
      ),
    );
    createdManyIds = createdMany.map((workItem) =>
      parseWorkItemId(workItem.id),
    );

    expect(createdMany).toHaveLength(2);
  });

  // test.serial("modifies one ticket", async () => {
  //   if (!createdSingle) {
  //     throw new Error("Expected the single ticket to be created first");
  //   }
  //   // modifiedSingle = await unwrapAsync(
  //   //   apiClient.api.tickets.put(createdSingle.id, {
  //   //     ref: createdSingle.ref,
  //   //     title: "Modify one ticket",
  //   //     description: "Updated single-ticket description",
  //   //     labels: ["bug", "customer"],
  //   //     fields: {
  //   //       status: "in_progress",
  //   //       priority: "medium",
  //   //     },
  //   //     json: {},
  //   //   }),
  //   // );
  //   //
  //   // modifiedSingle = await upsertOneAt(
  //   //   {
  //   //     ref: createdSingle.ref,
  //   //     title: "Modify one ticket",
  //   //     description: "Updated single-ticket description",
  //   //     labels: ["bug", "customer"],
  //   //     fields: {
  //   //       status: "in_progress",
  //   //       priority: "medium",
  //   //     },
  //   //     json: {},
  //   //   },
  //   //   "2026-04-23T10:10:00.000Z",
  //   // );
  //   //
  //   // expect(modifiedSingle.id).toBe(createdSingle.id);
  //   // expect(modifiedSingle.createdAt).toBe(createdSingle.createdAt);
  //   // expect(modifiedSingle.updatedAt).toBe("2026-04-23T10:10:00.000Z");
  //   //
  //   // const [loadedModifiedSingle] = await getTickets([modifiedSingle.id], {
  //   //   ticketRepo,
  //   // });
  //   // expect(loadedModifiedSingle?.title).toBe("Modify one ticket");
  //   // expect(loadedModifiedSingle?.labels).toEqual(["bug", "customer"]);
  // });
  //
  // test.serial("modifies multiple tickets", async () => {
  //   if (!createdMany) {
  //     throw new Error("Expected the batch tickets to be created first");
  //   }
  //
  //   modifiedMany = await upsertManyAt(
  //     [
  //       {
  //         ref: createdMany[0]!.ref,
  //         title: "Modify many ticket 1",
  //         description: "Updated first batch ticket",
  //         labels: ["triage", "investigating"],
  //         fields: {
  //           status: "in_progress",
  //         },
  //       },
  //       {
  //         ref: createdMany[1]!.ref,
  //         title: "Modify many ticket 2",
  //         description: "Updated second batch ticket",
  //         labels: ["feature", "ready"],
  //         fields: {
  //           status: "done",
  //         },
  //       },
  //     ],
  //     "2026-04-23T10:15:00.000Z",
  //   );
  //
  //   expect(modifiedMany.map((ticket) => ticket.id)).toEqual(
  //     createdMany.map((ticket) => ticket.id),
  //   );
  //
  //   const loadedModifiedMany = await getTickets(
  //     modifiedMany.map((ticket) => ticket.id),
  //     { ticketRepo },
  //   );
  //   expect(loadedModifiedMany.map((ticket) => ticket.title)).toEqual([
  //     "Modify many ticket 1",
  //     "Modify many ticket 2",
  //   ]);
  //   expect(await countPersistedTickets()).toBe(3);
  // });

  serialTest("deletes one work item", async () => {
    if (!createdSingleId) {
      throw new Error("Expected the single ticket to be modified first");
    }
    const deletedOneCount = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: createdSingleId }).delete(
        undefined,
        { headers: { ...authHeaders } },
      ),
    );

    expect(deletedOneCount).toBe(1);
    // expect(await countPersistedTickets()).toBe(2);

    const { data, error } = await apiClient.api["work-items"]({
      workItemId: createdSingleId,
    }).get({ headers: { ...authHeaders } });
    expect(data).toBeFalsy();
    expect(error).toBeDefined();
    expect(error?.status).toBe(404);
  });

  serialTest("deletes many work items", async () => {
    if (!createdManyIds) {
      throw new Error("Expected the batch tickets to be modified first");
    }

    const deletedManyCount = await unwrapAsync(
      apiClient.api["work-items"].batch.delete(
        {
          input: createdManyIds,
        },
        { headers: { ...authHeaders } },
      ),
    );
    expect(deletedManyCount).toBe(2);

    const createdManyFirstId = createdManyIds[0];
    const createdManySecondId = createdManyIds[1];
    if (!createdManyFirstId || !createdManySecondId) {
      throw new Error("Expected the modified tickets to have ids");
    }
    const { data, error } = await apiClient.api["work-items"]({
      workItemId: createdManyFirstId,
    }).get({ headers: { ...authHeaders } });
    expect(data).toBeFalsy();
    expect(error).toBeDefined();
    expect(error?.status).toBe(404);

    const { data: data2, error: error2 } = await apiClient.api["work-items"]({
      workItemId: createdManySecondId,
    }).get({ headers: { ...authHeaders } });
    expect(data2).toBeFalsy();
    expect(error2).toBeDefined();
    expect(error2?.status).toBe(404);
  });
});

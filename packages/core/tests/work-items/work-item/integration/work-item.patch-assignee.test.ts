import type { ProjectRole } from "@/projects/project/domain/project-role";
import { beforeAll, describe, expect } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { v7 as uuidv7 } from "uuid";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

describe("work item patch endpoint: assignee", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-22T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `work-item-patch-assignee-owner-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Work Item Assignee Project",
          description: "Project for work item patch tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );
  });

  const createNativeItem = async (headers: { authorization: string }) => {
    if (!project) {
      throw new Error("Expected project auth setup to complete");
    }
    return await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "scarn",
          platformId: null,
          platformKey: `manual-${uuidv7()}`,
          url: null,
          title: "Assignable",
          description: "Assignable description",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: { ...headers } },
      ),
    );
  };

  concurrentTest(
    "the author can assign a project member and clear the assignee",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }
      const member = await createTestUserAndSession({
        email: `work-item-patch-assignee-${crypto.randomUUID()}@example.com`,
      });
      const memberId = parseUuidV7(member.userId);
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .members({ userId: member.userId })
          .role.put({ role: "read" }, { headers: { ...authHeaders } }),
      );
      const workItem = await createNativeItem(authHeaders);
      expect(workItem.assigneeUserId).toBeNull();
      const route = apiClient.api["work-items"]({ workItemId: workItem.id });

      const assigned = await unwrapAsync(
        route.patch(
          {
            title: "Assignable",
            description: "Assignable description",
            descriptionVersion: 1,
            assigneeUserId: memberId,
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(assigned.assigneeUserId).toBe(memberId);

      const retitled = await unwrapAsync(
        route.patch(
          {
            title: "Retitled",
            description: "Assignable description",
            descriptionVersion: 1,
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(retitled.assigneeUserId).toBe(memberId);

      await unwrapAsync(
        route.patch(
          {
            title: "Retitled",
            description: "Assignable description",
            descriptionVersion: 1,
            assigneeUserId: null,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const persisted = await unwrapAsync(
        route.get({ headers: { ...authHeaders } }),
      );
      expect(persisted.assigneeUserId).toBeNull();
    },
  );

  const addMember = async (role: ProjectRole) => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }
    const member = await createTestUserAndSession({
      email: `work-item-patch-member-${crypto.randomUUID()}@example.com`,
    });
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .members({ userId: member.userId })
        .role.put({ role }, { headers: { ...authHeaders } }),
    );
    return { ...member, id: parseUuidV7(member.userId) };
  };

  concurrentTest(
    "a member who isn't the author can change only the assignee",
    async () => {
      if (!authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }
      const editor = await addMember("write");
      const workItem = await createNativeItem(authHeaders);

      const assigned = await unwrapAsync(
        apiClient.api["work-items"]({ workItemId: workItem.id }).patch(
          { assigneeUserId: editor.id },
          { headers: { ...editor.authHeaders } },
        ),
      );

      expect(assigned.assigneeUserId).toBe(editor.id);
      expect(assigned.title).toBe("Assignable");
      expect(assigned.description).toBe("Assignable description");
    },
  );

  concurrentTest("a synced work item can be assigned", async () => {
    if (!project || !authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }
    const assignee = await addMember("read");
    const workItem = await unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId: project.id,
          platform: "github",
          platformId: `synced-${uuidv7()}`,
          platformKey: `synced-${uuidv7()}`,
          url: "https://github.com/acme/repo/issues/2",
          title: "Synced title",
          description: "Synced description",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: {},
        },
        { headers: { ...authHeaders } },
      ),
    );

    const assigned = await unwrapAsync(
      apiClient.api["work-items"]({ workItemId: workItem.id }).patch(
        { assigneeUserId: assignee.id },
        { headers: { ...authHeaders } },
      ),
    );

    expect(assigned.assigneeUserId).toBe(assignee.id);
    expect(assigned.title).toBe("Synced title");
  });

  concurrentTest("a read-only member cannot change the assignee", async () => {
    if (!authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }
    const reader = await addMember("read");
    const workItem = await createNativeItem(authHeaders);

    const { data, error } = await apiClient.api["work-items"]({
      workItemId: workItem.id,
    }).patch(
      { assigneeUserId: reader.id },
      { headers: { ...reader.authHeaders } },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
  });

  concurrentTest("an empty patch is rejected", async () => {
    if (!authHeaders) {
      throw new Error("Expected project auth setup to complete");
    }
    const workItem = await createNativeItem(authHeaders);

    const { data, error } = await apiClient.api["work-items"]({
      workItemId: workItem.id,
    }).patch({}, { headers: { ...authHeaders } });

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
  });

  concurrentTest(
    "a member who isn't the author cannot change the title alongside the assignee",
    async () => {
      if (!authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }
      const editor = await addMember("write");
      const workItem = await createNativeItem(authHeaders);

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).patch(
        { title: "Hijacked", assigneeUserId: editor.id },
        { headers: { ...editor.authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
      expect(error?.value).toMatchObject({ code: "WORK_ITEM_NOT_AUTHOR" });
    },
  );

  concurrentTest(
    "a work item cannot be assigned to someone outside its project",
    async () => {
      if (!authHeaders) {
        throw new Error("Expected project auth setup to complete");
      }
      const outsider = await createTestUserAndSession({
        email: `work-item-patch-outsider-${crypto.randomUUID()}@example.com`,
      });
      const workItem = await createNativeItem(authHeaders);

      const { data, error } = await apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).patch(
        {
          title: "Assignable",
          description: "Assignable description",
          descriptionVersion: 1,
          assigneeUserId: parseUuidV7(outsider.userId),
        },
        { headers: { ...authHeaders } },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(422);
      expect(error?.value).toMatchObject({
        code: "WORK_ITEM_ASSIGNEE_NOT_PROJECT_MEMBER",
      });
    },
  );
});

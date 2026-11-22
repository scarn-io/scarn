import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "./auth-test-utils";
import { v7 as uuidv7 } from "uuid";
import { permissionsForRole } from "@scarn/core/projects/project/domain/project-role";

describe("project members endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-24T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  const createProject = async (headers: { authorization: string }) =>
    await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Members Project",
          description: "Project for member listing",
          gitUrl: "https://github.com/example/members-project.git",
        },
        { headers },
      ),
    );

  concurrentTest("lists every member with display fields", async () => {
    const owner = await createTestUserAndSession({
      email: `members-owner-${crypto.randomUUID()}@example.com`,
    });
    const member = await createTestUserAndSession({
      email: `members-member-${crypto.randomUUID()}@example.com`,
    });
    const project = await createProject(owner.authHeaders);
    await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .members({ userId: member.userId })
        .role.put({ role: "read" }, { headers: owner.authHeaders }),
    );

    const members = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .members.get({ headers: member.authHeaders }),
    );

    expect(members.map((m): string => m.userId).sort()).toEqual(
      [owner.userId, member.userId].sort(),
    );
    for (const listed of members) {
      expect(listed).toHaveProperty("username");
      expect(listed).toHaveProperty("image");
    }
    expect(members.find((m) => m.userId === owner.userId)).toMatchObject({
      role: "admin",
      permissions: [...permissionsForRole("admin")],
    });
    expect(members.find((m) => m.userId === member.userId)).toMatchObject({
      role: "read",
      permissions: [...permissionsForRole("read")],
    });
  });

  concurrentTest("returns 403 for a non-member", async () => {
    const owner = await createTestUserAndSession({
      email: `members-owner-${crypto.randomUUID()}@example.com`,
    });
    const outsider = await createTestUserAndSession({
      email: `members-outsider-${crypto.randomUUID()}@example.com`,
    });
    const project = await createProject(owner.authHeaders);

    const { data, error } = await apiClient.api
      .projects({ projectId: project.id })
      .members.get({ headers: outsider.authHeaders });

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.value).toMatchObject({ code: "PROJECT_FORBIDDEN" });
  });

  concurrentTest("returns 404 for an unknown project", async () => {
    const user = await createTestUserAndSession({
      email: `members-user-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await apiClient.api
      .projects({ projectId: uuidv7() })
      .members.get({ headers: user.authHeaders });

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
  });
});

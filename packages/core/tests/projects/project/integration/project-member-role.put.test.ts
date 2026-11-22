import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { describe, expect } from "bun:test";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import { permissionsForRole } from "@scarn/core/projects/project/domain/project-role";
import { createTestUserAndSession } from "./auth-test-utils";

describe("project member role endpoint", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-24T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);

  const newUser = async (label: string) =>
    await createTestUserAndSession({
      email: `${label}-${crypto.randomUUID()}@example.com`,
    });

  const createProject = async (headers: { authorization: string }) =>
    await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Member Role Project",
          description: "Role checks",
          gitUrl: "https://github.com/example/member-role-project.git",
        },
        { headers },
      ),
    );

  const memberRole = (projectId: string, userId: string) =>
    apiClient.api.projects({ projectId }).members({ userId }).role;

  concurrentTest("lets an admin change a member's role", async () => {
    const owner = await newUser("owner");
    const member = await newUser("member");
    const project = await createProject(owner.authHeaders);
    await unwrapAsync(
      memberRole(project.id, member.userId).put(
        { role: "read" },
        { headers: owner.authHeaders },
      ),
    );

    const updated = await unwrapAsync(
      memberRole(project.id, member.userId).put(
        { role: "write" },
        { headers: owner.authHeaders },
      ),
    );

    expect(updated).toMatchObject({
      userId: member.userId,
      role: "write",
      permissions: [...permissionsForRole("write")],
    });
    const members = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .members.get({ headers: owner.authHeaders }),
    );
    expect(members.find((m) => m.userId === member.userId)?.role).toBe("write");
  });

  concurrentTest("returns 403 when a write member changes a role", async () => {
    const owner = await newUser("owner");
    const writer = await newUser("writer");
    const reader = await newUser("reader");
    const project = await createProject(owner.authHeaders);
    await unwrapAsync(
      memberRole(project.id, writer.userId).put(
        { role: "write" },
        { headers: owner.authHeaders },
      ),
    );
    await unwrapAsync(
      memberRole(project.id, reader.userId).put(
        { role: "read" },
        { headers: owner.authHeaders },
      ),
    );

    const { data, error } = await memberRole(project.id, reader.userId).put(
      { role: "write" },
      { headers: writer.authHeaders },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.value).toMatchObject({
      status: 403,
      code: "PROJECT_FORBIDDEN",
    });
  });

  concurrentTest(
    "returns 403 when a read-only member assigns a role",
    async () => {
      const owner = await newUser("owner");
      const readOnlyMember = await newUser("readonly");
      const thirdUser = await newUser("third");
      const project = await createProject(owner.authHeaders);
      await unwrapAsync(
        memberRole(project.id, readOnlyMember.userId).put(
          { role: "read" },
          { headers: owner.authHeaders },
        ),
      );

      const { data, error } = await memberRole(
        project.id,
        thirdUser.userId,
      ).put({ role: "read" }, { headers: readOnlyMember.authHeaders });

      expect(data).toBeNull();
      expect(error?.status).toBe(403);
    },
  );

  concurrentTest("rejects an unknown role name with 422", async () => {
    const owner = await newUser("owner");
    const member = await newUser("member");
    const project = await createProject(owner.authHeaders);

    const { data, error } = await memberRole(project.id, member.userId).put(
      // @ts-expect-error -- only the three role names are accepted
      { role: "contributor" },
      { headers: owner.authHeaders },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "VALIDATION" });
  });

  concurrentTest(
    "returns 409 when the only admin demotes themselves",
    async () => {
      const owner = await newUser("owner");
      const project = await createProject(owner.authHeaders);

      const { data, error } = await memberRole(project.id, owner.userId).put(
        { role: "write" },
        { headers: owner.authHeaders },
      );

      expect(data).toBeNull();
      expect(error?.status).toBe(409);
      expect(error?.value).toMatchObject({ code: "PROJECT_LAST_ADMIN" });
    },
  );

  concurrentTest(
    "lets an admin step down once another admin exists",
    async () => {
      const owner = await newUser("owner");
      const coAdmin = await newUser("coadmin");
      const project = await createProject(owner.authHeaders);
      await unwrapAsync(
        memberRole(project.id, coAdmin.userId).put(
          { role: "admin" },
          { headers: owner.authHeaders },
        ),
      );

      const updated = await unwrapAsync(
        memberRole(project.id, owner.userId).put(
          { role: "read" },
          { headers: owner.authHeaders },
        ),
      );

      expect(updated.role).toBe("read");
    },
  );
});

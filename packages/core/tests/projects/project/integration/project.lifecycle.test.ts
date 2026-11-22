import { permissionsForRole } from "@/projects/project/domain/project-role";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createScarnTreaty } from "tests/treaty";
import { describe, expect } from "bun:test";
import { fixedTimeProvider, serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "./auth-test-utils";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

describe("project lifecycle plan", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-04-24T12:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  let projectId: string | undefined;
  let memberUserId: string | undefined;
  let ownerUsername: string | undefined;
  let ownerAuthHeaders: { authorization: string } | undefined;
  let memberAuthHeaders: { authorization: string } | undefined;

  serialTest("creates one project", async () => {
    ownerUsername = `owner${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const owner = await createTestUserAndSession({
      email: `owner-${crypto.randomUUID()}@example.com`,
      username: ownerUsername,
    });
    const member = await createTestUserAndSession({
      email: `member-${crypto.randomUUID()}@example.com`,
    });
    ownerAuthHeaders = owner.authHeaders;
    memberAuthHeaders = member.authHeaders;
    memberUserId = member.userId;

    const created = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Customer Ops",
          description: "Shared work item execution workflows",
          gitUrl: "https://github.com/example/customer-ops.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );
    projectId = created.id;

    expect(created.name).toBe("Customer Ops");
  });

  serialTest("assigns a project role to another user", async () => {
    if (!projectId || !memberUserId || !ownerAuthHeaders) {
      throw new Error("Expected project setup to complete first");
    }

    const memberMembership = await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .members({ userId: memberUserId })
        .role.put(
          { role: "read" },
          {
            headers: { ...ownerAuthHeaders },
          },
        ),
    );

    expect(memberMembership).toMatchObject({
      userId: memberUserId,
      role: "read",
      permissions: [...permissionsForRole("read")],
    });

    const project = await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .get({ headers: { ...ownerAuthHeaders } }),
    );
    const ownerMembership = project.memberships.find(
      (membership) => membership.userId !== memberUserId,
    );
    expect(ownerMembership).toMatchObject({
      role: "admin",
      permissions: [...permissionsForRole("admin")],
    });
  });

  serialTest("reads the project as an assigned member", async () => {
    if (!projectId || !memberAuthHeaders || !ownerUsername) {
      throw new Error("Expected membership assignment first");
    }

    const project = await unwrapAsync(
      apiClient.api.projects({ projectId }).get({
        headers: { ...memberAuthHeaders },
      }),
    );

    expect(project.id).toBe(parseUuidV7(projectId));
    expect(project.gitUrl).toBe("https://github.com/example/customer-ops.git");
    const memberMembership = project.memberships.find(
      (membership) => membership.userId === memberUserId,
    );

    expect(memberMembership).toMatchObject({
      role: "read",
      permissions: [...permissionsForRole("read")],
    });
    // The owner-username fix: a collaborator viewing a project owned by someone
    // else must see the OWNER's username (used to build `/{ownerUsername}/...`
    // links), NOT their own. Resolved at read time from the owning org's owner.
    expect(project.ownerUsername).toBe(ownerUsername);
  });

  serialTest(
    "lists the shared project with the owner's username for a collaborator",
    async () => {
      if (!projectId || !memberAuthHeaders || !ownerUsername) {
        throw new Error("Expected membership assignment first");
      }
      const targetProjectId = parseUuidV7(projectId);

      const projects = await unwrapAsync(
        apiClient.api.projects.get({ headers: { ...memberAuthHeaders } }),
      );

      const shared = projects.find((project) => project.id === targetProjectId);
      expect(shared).toBeDefined();
      // Dashboard link-builder correctness: the list read model carries the
      // OWNER's username so the member's link points at the owner's URL.
      expect(shared?.ownerUsername).toBe(ownerUsername);
    },
  );
});

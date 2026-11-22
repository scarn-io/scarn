import { describe, expect } from "bun:test";
import { ProjectEntity } from "@/projects/project/domain/project-entity";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { permissionsForRole } from "@/projects/project/domain/project-role";
import { concurrentTest } from "tests/utils";

describe("project entity", () => {
  concurrentTest("normalizes project values and keeps the member's role", () => {
    const projectId = createUuidV7();
    const userId = createUuidV7();
    const orgId = createUuidV7();

    const project = ProjectEntity.rehydrate({
      id: projectId,
      name: "  Delivery Platform  ",
      slug: "delivery-platform",
      description: "  Project scoped permissions  ",
      gitUrl: "https://github.com/example/delivery-platform.git",
      createdByUserId: userId,
      orgId,
      memberships: [{ projectId, userId, role: "write" }],
    });

    expect(project.name).toBe("Delivery Platform");
    expect(project.description).toBe("Project scoped permissions");
    expect(project.gitUrl).toBe(
      "https://github.com/example/delivery-platform.git",
    );
    expect(project.memberships[0]?.role).toBe("write");
    expect(project.memberships[0]?.permissions).toEqual(
      permissionsForRole("write"),
    );
  });

  concurrentTest(
    "loads a membership with a role this code doesn't know, granting nothing",
    () => {
      const projectId = createUuidV7();
      const userId = createUuidV7();

      const project = ProjectEntity.rehydrate({
        id: projectId,
        name: "Delivery Platform",
        slug: "delivery-platform",
        description: null,
        gitUrl: "https://github.com/example/delivery-platform.git",
        createdByUserId: userId,
        orgId: createUuidV7(),
        memberships: [{ projectId, userId, role: "retired-role" }],
      });

      expect(project.memberships[0]?.role).toBe("retired-role");
      expect(project.memberships[0]?.permissions).toEqual([]);
    },
  );

  concurrentTest("rejects invalid git urls", () => {
    const projectId = createUuidV7();
    const userId = createUuidV7();
    const orgId = createUuidV7();

    expect(() =>
      ProjectEntity.rehydrate({
        id: projectId,
        name: "Delivery Platform",
        slug: "delivery-platform",
        description: null,
        gitUrl: "not a git url",
        createdByUserId: userId,
        orgId,
        memberships: [
          {
            projectId,
            userId,
            role: "read",
          },
        ],
      }),
    ).toThrow("Project gitUrl must be a valid git repository URL or absolute path");
  });

  concurrentTest("defaults visibility to private when omitted", () => {
    const projectId = createUuidV7();
    const userId = createUuidV7();
    const orgId = createUuidV7();

    const project = ProjectEntity.rehydrate({
      id: projectId,
      name: "Delivery Platform",
      slug: "delivery-platform",
      description: null,
      gitUrl: "https://github.com/example/delivery-platform.git",
      createdByUserId: userId,
      orgId,
      memberships: [],
    });

    expect(project.visibility).toBe("private");
  });

  concurrentTest("withVisibility returns a new entity with the updated visibility", () => {
    const projectId = createUuidV7();
    const userId = createUuidV7();
    const orgId = createUuidV7();
    const updatedAt = new Date("2026-05-01T00:00:00.000Z");

    const project = ProjectEntity.rehydrate({
      id: projectId,
      name: "Delivery Platform",
      slug: "delivery-platform",
      description: null,
      gitUrl: "https://github.com/example/delivery-platform.git",
      createdByUserId: userId,
      orgId,
      memberships: [],
    });

    const madePublic = project.withVisibility("public", updatedAt);

    expect(project.visibility).toBe("private");
    expect(madePublic.visibility).toBe("public");
    expect(madePublic.updatedAt).toEqual(updatedAt);
  });
});

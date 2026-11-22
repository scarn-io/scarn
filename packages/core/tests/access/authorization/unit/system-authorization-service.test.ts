import { describe, expect, test } from "bun:test";
import { SystemAuthorizationService } from "@scarn/core/access/authorization/infra/system-authorization-service";
import { SYSTEM_ACTOR_ID } from "@scarn/core/access/authorization/system-actor";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { ProjectEntity } from "@scarn/core/projects/project/domain/project-entity";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { ResourceNotFoundError, CoreError } from "@scarn/core/lib/errors";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const orgId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f03");
const creatorId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f04");

const existingProject = ProjectEntity.create({
  id: projectId,
  name: "Test project",
  slug: "test-project",
  gitUrl: "https://github.com/acme/test-project.git",
  createdByUserId: creatorId,
  orgId,
  memberships: [],
});

const makeFakeRepo = (
  project: ProjectEntity | null = existingProject,
): ProjectRepo => ({
  load: () => Promise.resolve(project),
  loadForUpdate: () => Promise.resolve(project),
  loadMany: () => Promise.resolve([]),
  listByUser: () => Promise.resolve([]),
  loadByOrgAndSlug: () => Promise.resolve(null),
  listSlugsByOrg: () => Promise.resolve([]),
  create: (entity) => Promise.resolve(entity),
  save: (entity) => Promise.resolve(entity),
});

describe("SystemAuthorizationService", () => {
  test("actorId always resolves to SYSTEM_ACTOR_ID", () => {
    const service = new SystemAuthorizationService(makeFakeRepo());

    expect(service.actorId).toBe(SYSTEM_ACTOR_ID);
  });

  test("grants work-items:write when the project exists", async () => {
    const service = new SystemAuthorizationService(makeFakeRepo());

    let error: unknown = null;
    try {
      await service.requireProjectPermission({
        projectId,
        permission: "work-items:write",
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeNull();
  });

  test("grants work-items:update when the project exists", async () => {
    const service = new SystemAuthorizationService(makeFakeRepo());

    let error: unknown = null;
    try {
      await service.requireProjectPermission({
        projectId,
        permission: "work-items:update",
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeNull();
  });

  test("grants executions:write when the project exists", async () => {
    const service = new SystemAuthorizationService(makeFakeRepo());

    let error: unknown = null;
    try {
      await service.requireProjectPermission({
        projectId,
        permission: "executions:write",
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeNull();
  });

  test("throws for a permission outside the allowlist (work-items:read)", async () => {
    const service = new SystemAuthorizationService(makeFakeRepo());

    let error: unknown = null;
    try {
      await service.requireProjectPermission({
        projectId,
        permission: "work-items:read",
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).status).toBe(403);
  });

  test("throws for a permission outside the allowlist (comments:write)", async () => {
    const service = new SystemAuthorizationService(makeFakeRepo());

    let error: unknown = null;
    try {
      await service.requireProjectPermission({
        projectId,
        permission: "comments:write",
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).status).toBe(403);
  });

  test("throws ResourceNotFoundError for a nonexistent project", async () => {
    const service = new SystemAuthorizationService(makeFakeRepo(null));

    let error: unknown = null;
    try {
      await service.requireProjectPermission({
        projectId,
        permission: "work-items:write",
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });
});

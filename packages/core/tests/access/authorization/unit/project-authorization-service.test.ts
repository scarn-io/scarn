import { describe, expect, test } from "bun:test";
import { ProjectAuthorizationService } from "@scarn/core/access/authorization/infra/project-authorization-service";
import { SystemAuthorizationService } from "@scarn/core/access/authorization/infra/system-authorization-service";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { ProjectEntity } from "@scarn/core/projects/project/domain/project-entity";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { ResourceNotFoundError, CoreError } from "@scarn/core/lib/errors";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f12");
const orgId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f13");
const memberId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f14");
const outsiderId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f15");

const publicProject = ProjectEntity.create({
  id: projectId,
  name: "Test project",
  slug: "test-project",
  gitUrl: "https://github.com/acme/test-project.git",
  createdByUserId: memberId,
  orgId,
  visibility: "public",
  memberships: [
    { projectId, userId: memberId, role: "read" },
  ],
});

const makeFakeRepo = (
  project: ProjectEntity | null = publicProject,
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

const captureError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (caught: unknown) {
    return caught;
  }
  return null;
};

describe("requireProjectMember", () => {
  test("returns the membership for a project member", async () => {
    const service = new ProjectAuthorizationService(memberId, makeFakeRepo());

    const membership = await service.requireProjectMember(projectId);

    expect(membership.userId).toBe(memberId);
    expect(membership.projectId).toBe(projectId);
  });

  test("throws ResourceNotFoundError for a non-member of a public project", async () => {
    const service = new ProjectAuthorizationService(outsiderId, makeFakeRepo());

    const error = await captureError(() =>
      service.requireProjectMember(projectId),
    );

    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("throws ResourceNotFoundError for a missing project", async () => {
    const service = new ProjectAuthorizationService(
      memberId,
      makeFakeRepo(null),
    );

    const error = await captureError(() =>
      service.requireProjectMember(projectId),
    );

    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  test("throws 403 for the system actor on an existing project", async () => {
    const service = new SystemAuthorizationService(makeFakeRepo());

    const error = await captureError(() =>
      service.requireProjectMember(projectId),
    );

    expect(error).toBeInstanceOf(CoreError);
    expect(error).not.toBeInstanceOf(ResourceNotFoundError);
    expect((error as CoreError).status).toBe(403);
  });
});

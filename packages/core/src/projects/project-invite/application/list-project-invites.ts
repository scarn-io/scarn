import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { Result } from "@scarn/core/lib/result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { ProjectInviteEntity } from "../domain/project-invite-entity";
import type { ProjectInviteRepo } from "./project-invite-repo";

export type ListProjectInvitesInput = {
  projectId: UuidV7;
  actorId: UuidV7;
};

export type ListProjectInvitesError = {
  code: "UNAUTHORIZED";
  message: string;
};

export const listProjectInvites = async (
  input: ListProjectInvitesInput,
  {
    projectRepo,
    projectInviteRepo,
    dbExecutor,
  }: {
    projectRepo: ProjectRepo;
    projectInviteRepo: ProjectInviteRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ProjectInviteEntity[], ListProjectInvitesError>> => {
  const { projectId, actorId } = input;

  const project = await projectRepo.load(projectId, dbExecutor);

  if (!project) {
    return Result.err({
      code: "UNAUTHORIZED",
      message: "Insufficient permissions",
    });
  }

  const membership = project.getMembership(actorId);
  if (!membership?.permissions.includes("members:write")) {
    return Result.err({
      code: "UNAUTHORIZED",
      message: "Insufficient permissions",
    });
  }

  const invites = await projectInviteRepo.listPendingByProject(
    projectId,
    dbExecutor,
  );

  return Result.ok(invites);
};

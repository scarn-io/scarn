import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { Result } from "@scarn/core/lib/result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { ProjectInviteEntity } from "../domain/project-invite-entity";
import { ProjectInviteEntity as ProjectInviteEntityClass } from "../domain/project-invite-entity";
import type { ProjectInviteRepo } from "./project-invite-repo";

export type RevokeProjectInviteInput = {
  inviteId: UuidV7;
  actorId: UuidV7;
  projectId: UuidV7;
};

export type RevokeProjectInviteError =
  | { code: "UNAUTHORIZED"; message: string }
  | { code: "INVITE_NOT_FOUND"; message: string };

export const revokeProjectInvite = async (
  input: RevokeProjectInviteInput,
  {
    projectRepo,
    projectInviteRepo,
    dbExecutor,
  }: {
    projectRepo: ProjectRepo;
    projectInviteRepo: ProjectInviteRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ProjectInviteEntity, RevokeProjectInviteError>> => {
  const { inviteId, actorId, projectId } = input;

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

  // Load invite
  const invite = await projectInviteRepo.load(inviteId, dbExecutor);
  if (!invite) {
    return Result.err({
      code: "INVITE_NOT_FOUND",
      message: "Invite not found",
    });
  }

  // Security check: verify invite belongs to this project
  if (invite.projectId !== projectId) {
    return Result.err({
      code: "INVITE_NOT_FOUND",
      message: "Invite not found",
    });
  }

  const now = new Date();
  const revokedInvite = ProjectInviteEntityClass.create({
    ...invite.toJSON(),
    status: "revoked",
    updatedAt: now,
  });

  const savedInvite = await projectInviteRepo.save(revokedInvite, dbExecutor);

  return Result.ok(savedInvite);
};

import type { ProjectInviteEntity } from "@scarn/core/projects/project-invite/domain/project-invite-entity";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";

export interface ProjectInviteRepo {
  save(
    invite: ProjectInviteEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity>;
  load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity | null>;
  loadByTokenHash(
    tokenHash: string,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity | null>;
  loadPendingByProjectAndEmail(
    projectId: UuidV7,
    email: string,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity | null>;
  loadPendingByProjectAndRestriction(
    projectId: UuidV7,
    restriction: ProjectInviteEntity["restriction"],
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity | null>;
  listPendingByProject(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity[]>;
  saveMany(
    invites: ProjectInviteEntity[],
    dbExecutor?: DbExecutor,
  ): Promise<ProjectInviteEntity[]>;
}

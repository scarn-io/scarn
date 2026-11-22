import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { assertProjectPermission } from "@scarn/core/projects/project/application/project-authorization";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ProjectMembership } from "@scarn/core/projects/project/domain/project-membership";
import type {
  UserAuthorizationService,
  RequireProjectPermissionInput,
  ProjectPermissionGrant,
} from "../application/user-authorization-service";

export class ProjectAuthorizationService implements UserAuthorizationService {
  public constructor(
    public readonly actorId: UuidV7,
    private readonly projectRepo: ProjectRepo,
  ) {}

  public async requireProjectPermission({
    projectId,
    permission,
    dbExecutor,
  }: RequireProjectPermissionInput): Promise<ProjectPermissionGrant> {
    const project = await this.projectRepo.load(projectId, dbExecutor);

    if (!project) {
      throw new ResourceNotFoundError("Project", projectId);
    }

    return assertProjectPermission(project, this.actorId, permission);
  }

  public async requireProjectMember(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ProjectMembership> {
    const project = await this.projectRepo.load(projectId, dbExecutor);
    const membership = project?.getMembership(this.actorId);

    if (!membership) {
      throw new ResourceNotFoundError("Project", projectId);
    }

    return membership;
  }
}

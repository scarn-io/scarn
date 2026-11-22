import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import type { ArtifactRepo } from "./artifact-repo";
import {
  listProjectArtifactsResponseSchema,
  type ListProjectArtifactsResponse,
} from "../contracts/task-artifact-contracts";

const DEFAULT_LIMIT = 50;

/**
 * List artifacts recorded across a project's tasks (newest first),
 * after verifying the caller may read the project's executions.
 */
export const listProjectArtifacts = async (
  projectId: string,
  {
    userAuthz,
    artifactRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    artifactRepo: ArtifactRepo;
    dbExecutor?: DbExecutor;
  },
): Promise<ListProjectArtifactsResponse> => {
  const parsedProjectId = uuidV7Schema.parse(projectId);
  await userAuthz.requireProjectPermission({
    projectId: parsedProjectId,
    permission: "executions:read",
  });

  const rows = await artifactRepo.listByProjectId(
    parsedProjectId,
    DEFAULT_LIMIT,
    dbExecutor,
  );
  const hasMore = rows.length > DEFAULT_LIMIT;
  return listProjectArtifactsResponseSchema.parse({
    artifacts: hasMore ? rows.slice(0, DEFAULT_LIMIT) : rows,
    hasMore,
  });
};

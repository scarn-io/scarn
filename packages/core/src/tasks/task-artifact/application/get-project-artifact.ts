import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { ArtifactRepo, ArtifactWithRunContext } from "./artifact-repo";
import {
  projectArtifactDetailSchema,
  type ProjectArtifactDetailContract,
  type ProjectArtifactStatus,
} from "../contracts/task-artifact-contracts";

const statusOf = (artifact: ArtifactWithRunContext): ProjectArtifactStatus => {
  if (artifact.deletedAt !== null) {
    return "deleted";
  }
  if (artifact.storeRef === null || artifact.objectKey === null) {
    return "expired";
  }
  return "available";
};

/**
 * Metadata for the durable artifact page that posted comment links point at.
 * Deleted and expired artifacts are still returned (with their `status`) so
 * the page can say what happened instead of 404ing. An artifact that belongs
 * to a different project is reported as not found.
 */
export const getProjectArtifact = async (
  projectIdInput: string,
  artifactIdInput: string,
  {
    userAuthz,
    artifactRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    artifactRepo: ArtifactRepo;
    dbExecutor?: DbExecutor;
  },
): Promise<Result<ProjectArtifactDetailContract, ResourceNotFoundError>> => {
  const projectId = uuidV7Schema.parse(projectIdInput);
  const artifactId = uuidV7Schema.parse(artifactIdInput);

  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
  });

  const artifact = await artifactRepo.findWithRunContextById(
    artifactId,
    dbExecutor,
  );
  if (!artifact || artifact.projectId !== projectId) {
    return Result.err(new ResourceNotFoundError("Artifact", artifactId));
  }

  return Result.ok(
    projectArtifactDetailSchema.parse({
      id: artifact.id,
      taskRunId: artifact.taskRunId,
      projectId: artifact.projectId,
      relativeStorePath: artifact.relativeStorePath,
      sizeBytes: artifact.sizeBytes,
      contentType: artifact.contentType,
      kind: artifact.kind,
      createdAt: artifact.createdAt,
      status: statusOf(artifact),
      pipelineRunId: artifact.pipelineRunId,
      attemptNumber: artifact.attemptNumber,
      nodeKey: artifact.nodeKey,
    }),
  );
};

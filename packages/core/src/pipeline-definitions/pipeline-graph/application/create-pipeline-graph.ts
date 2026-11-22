import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { getDb } from "@scarn/core/lib/db";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { AnalyticsPort } from "@scarn/core/lib/analytics/analytics-port";
import {
  AnalyticsEvents,
  type PipelineCreatedProperties,
} from "@scarn/observability/analytics/events";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  createPipelineDefinitionInputSchema,
  type CreatePipelineDefinitionInput,
  type PipelineDefinitionContract,
} from "../contracts/pipeline-graph-contracts";
import { PipelineGraphEntity } from "../domain/pipeline-graph-entity";
import type { PipelineGraphVersionEntity } from "../domain/pipeline-graph-version-entity";
import { pipelineGraphEntityToContract } from "./pipeline-graph-contract-mapper";
import {
  publishPipelineGraphVersion,
  type PublishPipelineGraphVersionDeps,
} from "./publish-pipeline-graph-version";

/**
 * Creates a pipeline. With a `document`, it is validated and published as
 * version 1 in the same transaction; a pipeline without one has no active
 * version until something is published.
 */
export const createPipelineGraph = async (
  input: CreatePipelineDefinitionInput,
  {
    userAuthz,
    analytics,
    via,
    dbExecutor,
    ...deps
  }: PublishPipelineGraphVersionDeps & {
    userAuthz?: UserAuthorizationService | undefined;
    analytics: AnalyticsPort;
    via: PipelineCreatedProperties["via"];
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<PipelineDefinitionContract, CoreValidationError>> => {
  const parsedInput = createPipelineDefinitionInputSchema.parse(input);
  if (userAuthz) {
    await userAuthz.requireProjectPermission({
      projectId: parsedInput.projectId,
      permission: "pipelines:write",
    });
  }

  const run = async (tx: DbExecutor) => {
    const now = deps.timeProvider.now();
    let handle = await deps.pipelineGraphRepo.insertHandle(
      PipelineGraphEntity.create({
        projectId: parsedInput.projectId,
        key: parsedInput.key,
        name: parsedInput.name,
        currentVersionId: null,
        createdAt: now,
        updatedAt: now,
      }),
      tx,
    );
    let currentVersion: PipelineGraphVersionEntity | null = null;
    if (parsedInput.document) {
      const published = await publishPipelineGraphVersion(
        handle,
        parsedInput.document,
        deps,
        tx,
      );
      if (!published.ok) {
        throw published.error;
      }
      handle = published.value.handle;
      currentVersion = published.value.version;
    }
    return pipelineGraphEntityToContract({ handle, currentVersion });
  };

  let contract: PipelineDefinitionContract;
  try {
    contract = dbExecutor
      ? await dbExecutor.transaction(run)
      : await getDb().transaction(run);
  } catch (error) {
    if (
      error instanceof CoreValidationError &&
      error.code.startsWith("PIPELINE_DOCUMENT_")
    ) {
      return Result.err(error);
    }
    throw error;
  }

  if (userAuthz) {
    analytics.capture(userAuthz.actorId, AnalyticsEvents.PipelineCreated, {
      project_id: contract.projectId,
      pipeline_definition_id: contract.id,
      via,
    });
  }
  return Result.ok(contract);
};

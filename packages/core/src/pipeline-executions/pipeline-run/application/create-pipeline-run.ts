import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceConflictError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { PipelineGraphRepo } from "@scarn/core/pipeline-definitions/pipeline-graph/application/pipeline-graph-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import {
  createPipelineExecutionInputSchema,
  type CreatePipelineExecutionInput,
  type PipelineExecutionContract,
} from "../contracts/pipeline-run-contracts";
import { PipelineRunEntity } from "../domain/pipeline-run-entity";
import type { RunCompletion } from "../domain/run-completion";
import { advancePipelineRun } from "./advance-pipeline-run";
import {
  projectPipelineRunsToContracts,
  type PipelineRunReadDeps,
} from "./pipeline-run-contract-mapper";
import { reportRunCompletion } from "./report-run-completion";
import type { TaskAndAdvanceDeps } from "./task-and-advance";

export type CreatePipelineRunDeps = TaskAndAdvanceDeps &
  PipelineRunReadDeps & {
    userAuthz: UserAuthorizationService;
    pipelineGraphRepo: PipelineGraphRepo;
    /**
     * `actor` records `userAuthz.actorId` as the run's `triggeredByUserId`.
     * `system` stores null, for runs a system path starts on a user's behalf
     * (default pipeline assignment during integration sync).
     * `{ automationId }` stores null and records the automation that started
     * the run.
     */
    triggeredBy: "actor" | "system" | { automationId: UuidV7 };
  };

export type CreatePipelineRunError =
  ResourceNotFoundError | CoreValidationError | ResourceConflictError;

/**
 * Starts a run of the pipeline's active version (or `version`) against a
 * work item: inserts the run, then advances it with `start` in the same
 * transaction. Only one open run per work item and pipeline.
 */
export const createPipelineRun = async (
  input: CreatePipelineExecutionInput,
  deps: CreatePipelineRunDeps,
): Promise<Result<PipelineExecutionContract, CreatePipelineRunError>> => {
  const parsed = createPipelineExecutionInputSchema.parse(input);
  await deps.userAuthz.requireProjectPermission({
    projectId: parsed.projectId,
    permission: "executions:write",
    dbExecutor: deps.dbExecutor,
  });
  const pipelineGraphId = parseUuidV7(parsed.pipelineDefinitionId);
  const workItemId = parseWorkItemId(parsed.workItemId);

  const db: DbExecutor = deps.dbExecutor ?? getDb();
  let completion: RunCompletion | null = null;
  const created = await db.transaction(
    async (tx): Promise<Result<PipelineRunEntity, CreatePipelineRunError>> => {
      const handle = await deps.pipelineGraphRepo.loadHandle(
        pipelineGraphId,
        tx,
      );
      if (!handle || handle.projectId !== parsed.projectId) {
        return Result.err(
          new ResourceNotFoundError("Pipeline graph", pipelineGraphId),
        );
      }
      if (handle.isArchived) {
        return Result.err(
          new CoreValidationError(
            "An archived pipeline can't be run",
            "PIPELINE_GRAPH_ARCHIVED",
          ),
        );
      }
      const version =
        parsed.version === undefined
          ? handle.currentVersionId
            ? await deps.pipelineGraphVersionRepo.load(
                handle.currentVersionId,
                tx,
              )
            : null
          : await deps.pipelineGraphVersionRepo.loadByNumber(
              handle.id,
              parsed.version,
              tx,
            );
      if (!version) {
        return parsed.version === undefined
          ? Result.err(
              new CoreValidationError(
                "Pipeline has no active version",
                "PIPELINE_GRAPH_NO_CURRENT_VERSION",
              ),
            )
          : Result.err(
              new ResourceNotFoundError(
                "Pipeline graph version",
                `${handle.key}@${String(parsed.version)}`,
              ),
            );
      }

      const existing =
        await deps.pipelineRunRepo.listByWorkItemAndPipelineGraphId(
          workItemId,
          handle.id,
          tx,
        );
      if (existing.some((run) => run.isOpen)) {
        return Result.err(
          new ResourceConflictError(
            "Pipeline run",
            `${parsed.workItemId}/${handle.id}`,
          ),
        );
      }

      const now = deps.timeProvider.now();
      const run = await deps.pipelineRunRepo.create(
        PipelineRunEntity.create({
          projectId: parsed.projectId,
          workItemId: parseUuidV7(parsed.workItemId),
          pipelineGraphId: handle.id,
          pipelineGraphVersionId: version.id,
          status: "active",
          triggeredByUserId:
            deps.triggeredBy === "actor" ? deps.userAuthz.actorId : null,
          startedByAutomationId:
            typeof deps.triggeredBy === "object"
              ? deps.triggeredBy.automationId
              : null,
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        }),
        tx,
      );
      const started = await advancePipelineRun(
        run.id,
        { type: "start" },
        deps,
        tx,
      );
      if (!started.ok) {
        throw started.error;
      }
      completion = started.value.completion;
      return Result.ok(started.value.run);
    },
  );
  if (!created.ok) {
    return created;
  }
  if (!deps.dbExecutor) {
    await reportRunCompletion(completion, deps);
  }
  const [contract] = await projectPipelineRunsToContracts(
    [created.value],
    deps,
  );
  return contract
    ? Result.ok(contract)
    : Result.err(new ResourceNotFoundError("Pipeline run", created.value.id));
};

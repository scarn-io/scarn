import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  recordArtifactFailureInputSchema,
  type ArtifactFailureContract,
  type RecordArtifactFailureInput,
} from "../contracts/task-artifact-failure-contracts";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import type { ArtifactFailureRepo } from "./artifact-failure-repo";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { assertClaimOwnership } from "@scarn/core/tasks/task-run/application/task-run-claim-helpers";

/**
 * Matches Phase 0's `classifyArtifactSaveError` cap
 * (`packages/worker/src/artifacts/artifact-store/domain/classify-artifact-save-error.ts`)
 * so a message already capped by the worker round-trips unchanged, while still
 * defending this insert path against any caller that skips that helper.
 */
const MAX_ERROR_MESSAGE_LENGTH = 1000;

const capErrorMessage = (message: string): string =>
  message.length > MAX_ERROR_MESSAGE_LENGTH
    ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH)
    : message;

/**
 * Persists a failed artifact-upload attempt reported by the owning worker.
 * Purely informational — never touches usage metering (nothing was actually
 * stored) or policy evaluation.
 */
export const recordTaskArtifactFailure = async (
  taskIdInput: GetTaskRunInput,
  input: RecordArtifactFailureInput,
  {
    userAuthz,
    taskRunRepo: taskRunRepo,
    artifactFailureRepo,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    artifactFailureRepo: ArtifactFailureRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ArtifactFailureContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsedInput = recordArtifactFailureInputSchema.parse(input);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:write",
  });

  assertClaimOwnership(task, parsedInput.claimToken, timeProvider.now());

  const failure = await artifactFailureRepo.record(
    {
      id: createUuidV7(),
      taskRunId: task.id,
      projectId: task.projectId,
      relativeStorePath: parsedInput.relativeStorePath,
      attemptedSizeBytes: parsedInput.attemptedSizeBytes,
      kind: parsedInput.kind ?? "generic",
      errorCode: parsedInput.errorCode,
      errorMessage: capErrorMessage(parsedInput.errorMessage),
      httpStatus: parsedInput.httpStatus ?? null,
    },
    dbExecutor,
  );

  return Result.ok(failure);
};

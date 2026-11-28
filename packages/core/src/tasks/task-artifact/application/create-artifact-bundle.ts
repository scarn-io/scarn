import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { assertClaimOwnership } from "@scarn/core/tasks/task-run/application/task-run-claim-helpers";
import {
  normalizeArtifactBundleEntry,
  parseArtifactBundleSpec,
} from "../domain/artifact-bundle";
import { findBundleField } from "../domain/bundle-field";
import {
  createArtifactBundleInputSchema,
  type ArtifactBundleContract,
  type CreateArtifactBundleInput,
} from "../contracts/task-artifact-contracts";
import type { ArtifactBundleRepo } from "./artifact-bundle-repo";
import { toArtifactBundleContract } from "./artifact-bundle-contract";

/**
 * Open a `pending` artifact bundle for the running task. Requires
 * `executions:write` and the worker's claim.
 *
 * With `fieldPath`, the bundle fills a declared bundle field: the path must
 * name a bundle field in the Task's result schema, and the entry (defaulting
 * to the field's declared entry) must match it. Without it, the bundle is
 * undeclared and its entry defaults to `index.html`.
 *
 * Throws a `CoreValidationError` for an invalid name, root, entry or field and
 * a `ResourceConflictError` when the task run already has a bundle with the
 * same name.
 */
export const createArtifactBundle = async (
  taskIdInput: GetTaskRunInput,
  input: CreateArtifactBundleInput,
  {
    userAuthz,
    taskRunRepo,
    artifactBundleRepo,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    artifactBundleRepo: ArtifactBundleRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ArtifactBundleContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsedInput = createArtifactBundleInputSchema.parse(input);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }
  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:write",
  });

  assertClaimOwnership(task, parsedInput.claimToken, timeProvider.now());

  const field =
    parsedInput.fieldPath === undefined
      ? null
      : findBundleField(task.resultSchemaJson, parsedInput.fieldPath);
  if (parsedInput.fieldPath !== undefined && !field) {
    throw new CoreValidationError(
      `${parsedInput.fieldPath} is not a bundle field in this Task's result schema`,
      "ARTIFACT_BUNDLE_FIELD_UNKNOWN",
      { fieldPath: parsedInput.fieldPath },
    );
  }

  const spec = parseArtifactBundleSpec({
    name: parsedInput.name,
    rootPath: parsedInput.rootPath,
    entryPath: parsedInput.entryPath ?? field?.entry,
  });
  if (field && spec.entryPath !== normalizeArtifactBundleEntry(field.entry)) {
    throw new CoreValidationError(
      `Bundle entry ${spec.entryPath} does not match the entry ${field.entry} declared by ${field.path}`,
      "ARTIFACT_BUNDLE_ENTRY_MISMATCH",
      {
        fieldPath: field.path,
        entryPath: spec.entryPath,
        declaredEntry: field.entry,
      },
    );
  }

  const bundle = await artifactBundleRepo.create(
    {
      id: createUuidV7(),
      projectId: task.projectId,
      taskRunId: task.id,
      fieldPath: field?.path ?? null,
      ...spec,
    },
    dbExecutor,
  );

  return Result.ok(toArtifactBundleContract(bundle, timeProvider.now()));
};

import { findArtifactFields } from "@scarn/sdk/contracts/artifacts";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ArtifactRepo } from "@scarn/core/tasks/task-artifact/application/artifact-repo";
import type { ArtifactFailureRepo } from "@scarn/core/tasks/task-artifact/application/artifact-failure-repo";
import type { TaskRunEntity } from "../domain/task-run-entity";
import {
  readResultPath,
  resolveArtifactField,
} from "../domain/resolve-artifact-field";
import type {
  TaskArtifactResolution,
  TaskArtifactResolutionRepo,
} from "./task-artifact-resolution-repo";

export type ResolveTaskArtifactsDeps = {
  artifactRepo: Pick<ArtifactRepo, "listByTask">;
  artifactFailureRepo: Pick<ArtifactFailureRepo, "listByTask">;
  taskArtifactResolutionRepo: TaskArtifactResolutionRepo;
};

/**
 * Resolves every artifact field (`x-scarn-artifact`) of a completed Task's
 * result against the files the worker uploaded, and records the outcome in
 * `task_artifact_resolutions`. Fields inside arrays are not resolved.
 */
export const resolveTaskArtifacts = async (
  task: TaskRunEntity,
  {
    artifactRepo,
    artifactFailureRepo,
    taskArtifactResolutionRepo,
  }: ResolveTaskArtifactsDeps,
  dbExecutor: DbExecutor,
): Promise<TaskArtifactResolution[]> => {
  const fields = findArtifactFields(task.resultSchemaJson).filter(
    (field) => !field.inArray,
  );
  if (fields.length === 0) {
    return [];
  }

  const values = fields.map((field) => ({
    field,
    rawValue: readResultPath(task.resultJson, field.path),
  }));
  const anyReported = values.some(
    ({ rawValue }) => rawValue !== undefined && rawValue !== null,
  );
  const artifacts = anyReported
    ? await artifactRepo.listByTask(task.id, dbExecutor)
    : [];
  const failures = anyReported
    ? await artifactFailureRepo.listByTask(task.id, dbExecutor)
    : [];

  const resolutions = values.map(({ field, rawValue }) => {
    const resolved = resolveArtifactField({
      rawValue,
      accept: field.accept,
      artifacts,
      failures,
    });
    return {
      taskRunId: task.id,
      resultPath: field.path,
      artifactId: resolved.artifact?.id ?? null,
      unavailableReason: resolved.unavailableReason,
    };
  });
  await taskArtifactResolutionRepo.replaceForTask(
    task.id,
    resolutions,
    dbExecutor,
  );
  return resolutions;
};

import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { PipelineRunEntity } from "./pipeline-run-entity";

/** A run reaching a terminal status within one `advance`. */
export type RunCompletion = {
  pipelineRunId: UuidV7;
  projectId: UuidV7;
  triggeredByUserId: UuidV7 | null;
  status: "succeeded" | "failed" | "cancelled";
  /** From the run's start (or creation) to its completion. */
  durationMs: number;
};

/** The completion `after` reached, when `before` was still open. */
export const detectRunCompletion = (
  before: PipelineRunEntity,
  after: PipelineRunEntity,
): RunCompletion | null => {
  if (!before.isOpen || after.isOpen) {
    return null;
  }
  const status = after.status as RunCompletion["status"];
  const startedAt = after.startedAt ?? after.createdAt ?? null;
  const completedAt = after.completedAt ?? after.updatedAt ?? null;
  const durationMs =
    startedAt && completedAt
      ? Math.max(0, completedAt.getTime() - startedAt.getTime())
      : 0;
  return {
    pipelineRunId: after.id,
    projectId: after.projectId,
    triggeredByUserId: after.triggeredByUserId,
    status,
    durationMs,
  };
};

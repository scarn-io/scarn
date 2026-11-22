import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";
import type { RunInfo, RunPatch } from "./engine/types";

/**
 * Stored run statuses. `active` and `waiting` are open; the rest are
 * terminal. Queued/running are derived when reading (see
 * `derive-pipeline-run-display-status.ts`).
 */
export const pipelineRunStatusValues = [
  "active",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type PipelineRunStatus = (typeof pipelineRunStatusValues)[number];

export const isPipelineRunOpen = (status: PipelineRunStatus): boolean =>
  status === "active" || status === "waiting";

export type PipelineRunEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  workItemId: UuidV7;
  pipelineGraphId: UuidV7;
  pipelineGraphVersionId: UuidV7;
  status: PipelineRunStatus;
  endNodeId?: string | null | undefined;
  errorJson?: AnyJsonValue | null | undefined;
  triggeredByUserId?: UuidV7 | null | undefined;
  startedByAutomationId?: UuidV7 | null | undefined;
  cancelledByUserId?: UuidV7 | null | undefined;
  startedAt?: Date | string | null | undefined;
  completedAt?: Date | string | null | undefined;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
};

export type CreatePipelineRunEntityProps = Omit<
  PipelineRunEntityProps,
  "id"
> & { id?: UuidV7 | undefined };

/**
 * One run of a pinned pipeline version against a work item. The run row
 * holds only the engine's decisions; its history is the visits.
 */
export class PipelineRunEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly workItemId: UuidV7;
  public readonly pipelineGraphId: UuidV7;
  public readonly pipelineGraphVersionId: UuidV7;
  public readonly status: PipelineRunStatus;
  public readonly endNodeId: string | null;
  public readonly errorJson: AnyJsonValue | null;
  public readonly triggeredByUserId: UuidV7 | null;
  public readonly startedByAutomationId: UuidV7 | null;
  public readonly cancelledByUserId: UuidV7 | null;
  public readonly startedAt: Date | null;
  public readonly completedAt: Date | null;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;

  private constructor(props: PipelineRunEntityProps) {
    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.workItemId = parseUuidV7(props.workItemId);
    this.pipelineGraphId = parseUuidV7(props.pipelineGraphId);
    this.pipelineGraphVersionId = parseUuidV7(props.pipelineGraphVersionId);
    this.status = props.status;
    this.endNodeId = props.endNodeId ?? null;
    this.errorJson = props.errorJson ?? null;
    this.triggeredByUserId = props.triggeredByUserId
      ? parseUuidV7(props.triggeredByUserId)
      : null;
    this.startedByAutomationId = props.startedByAutomationId
      ? parseUuidV7(props.startedByAutomationId)
      : null;
    this.cancelledByUserId = props.cancelledByUserId
      ? parseUuidV7(props.cancelledByUserId)
      : null;
    this.startedAt = normalizeDate(props.startedAt) ?? null;
    this.completedAt = normalizeDate(props.completedAt) ?? null;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
  }

  static create(props: CreatePipelineRunEntityProps): PipelineRunEntity {
    return new PipelineRunEntity({ ...props, id: props.id ?? createUuidV7() });
  }

  static rehydrate(props: PipelineRunEntityProps): PipelineRunEntity {
    return new PipelineRunEntity(props);
  }

  get isOpen(): boolean {
    return isPipelineRunOpen(this.status);
  }

  /** The run as `decide` reads it. */
  toRunInfo(): RunInfo {
    return {
      id: this.id,
      status: this.status,
      endNodeId: this.endNodeId,
      error: (this.errorJson as RunInfo["error"]) ?? null,
      cancelledByUserId: this.cancelledByUserId,
      completedAt: this.completedAt?.toISOString() ?? null,
    };
  }

  /** Applies an engine `updateRun` patch. */
  withPatch(patch: RunPatch, now: Date): PipelineRunEntity {
    const props = this.toJSON();
    return new PipelineRunEntity({
      ...props,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.endNodeId !== undefined ? { endNodeId: patch.endNodeId } : {}),
      ...(patch.error !== undefined
        ? { errorJson: patch.error as AnyJsonValue | null }
        : {}),
      ...(patch.cancelledByUserId !== undefined
        ? {
            cancelledByUserId:
              patch.cancelledByUserId === null
                ? null
                : parseUuidV7(patch.cancelledByUserId),
          }
        : {}),
      ...(patch.completedAt !== undefined
        ? { completedAt: patch.completedAt }
        : {}),
      updatedAt: now,
    });
  }

  toJSON(): PipelineRunEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      workItemId: this.workItemId,
      pipelineGraphId: this.pipelineGraphId,
      pipelineGraphVersionId: this.pipelineGraphVersionId,
      status: this.status,
      endNodeId: this.endNodeId,
      errorJson: this.errorJson,
      triggeredByUserId: this.triggeredByUserId,
      startedByAutomationId: this.startedByAutomationId,
      cancelledByUserId: this.cancelledByUserId,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

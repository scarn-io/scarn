import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const ARTIFACT_DELETED_DOMAIN_EVENT_TYPE = "task-artifact.deleted";

export type ArtifactDeletedDomainEventPayload = {
  orgId: UuidV7;
  projectId: UuidV7;
  taskRunId: UuidV7;
  artifactId: UuidV7;
  sizeBytes: number;
};

export class ArtifactDeletedDomainEvent implements DomainEvent<
  typeof ARTIFACT_DELETED_DOMAIN_EVENT_TYPE,
  ArtifactDeletedDomainEventPayload
> {
  readonly type = ARTIFACT_DELETED_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: ArtifactDeletedDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}

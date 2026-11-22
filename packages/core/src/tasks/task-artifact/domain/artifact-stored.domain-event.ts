import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const ARTIFACT_STORED_DOMAIN_EVENT_TYPE = "task-artifact.stored";

export type ArtifactStoredDomainEventPayload = {
  orgId: UuidV7;
  projectId: UuidV7;
  taskRunId: UuidV7;
  artifactId: UuidV7;
  sizeBytes: number;
};

export class ArtifactStoredDomainEvent implements DomainEvent<
  typeof ARTIFACT_STORED_DOMAIN_EVENT_TYPE,
  ArtifactStoredDomainEventPayload
> {
  readonly type = ARTIFACT_STORED_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: ArtifactStoredDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}

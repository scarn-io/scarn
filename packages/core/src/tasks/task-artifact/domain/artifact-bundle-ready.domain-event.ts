import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const ARTIFACT_BUNDLE_READY_DOMAIN_EVENT_TYPE =
  "task-artifact.bundle-ready";

export type ArtifactBundleReadyDomainEventPayload = {
  orgId: UuidV7;
  projectId: UuidV7;
  taskRunId: UuidV7;
  bundleId: UuidV7;
  fileCount: number;
  sizeBytes: number;
};

export class ArtifactBundleReadyDomainEvent implements DomainEvent<
  typeof ARTIFACT_BUNDLE_READY_DOMAIN_EVENT_TYPE,
  ArtifactBundleReadyDomainEventPayload
> {
  readonly type = ARTIFACT_BUNDLE_READY_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: ArtifactBundleReadyDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}

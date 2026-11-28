import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const ARTIFACT_SHARE_SERVED_DOMAIN_EVENT_TYPE = "artifact-share.served";

/**
 * A file was served from the content origin (plan decision 15). `via` says
 * whether it came through a share link or a member's preview token; for
 * previews `shareId` is null.
 */
export type ArtifactShareServedDomainEventPayload = {
  orgId?: UuidV7;
  projectId: UuidV7;
  bundleId: UuidV7;
  shareId: UuidV7 | null;
  path: string;
  bytes: number;
  via: "share" | "preview";
};

export class ArtifactShareServedDomainEvent implements DomainEvent<
  typeof ARTIFACT_SHARE_SERVED_DOMAIN_EVENT_TYPE,
  ArtifactShareServedDomainEventPayload
> {
  readonly type = ARTIFACT_SHARE_SERVED_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: ArtifactShareServedDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}

import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";

export const PROJECT_CREATED_DOMAIN_EVENT_TYPE = "project.created";

export type ProjectCreatedDomainEventPayload = {
  projectId: UuidV7;
  createdByUserId: UuidV7;
};

export class ProjectCreatedDomainEvent
  implements
    DomainEvent<
      typeof PROJECT_CREATED_DOMAIN_EVENT_TYPE,
      ProjectCreatedDomainEventPayload
    >
{
  readonly type = PROJECT_CREATED_DOMAIN_EVENT_TYPE;
  readonly occurredAt: Date;

  constructor(
    readonly payload: ProjectCreatedDomainEventPayload,
    occurredAt = new Date(),
  ) {
    this.occurredAt = occurredAt;
  }
}
